import { useEffect, useMemo, useState, type JSX } from "react";
import * as THREE from "three";
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldAlert } from "lucide-react";

import { fetchRecordFile, fetchStagingFile } from "@/lib/api";
import { findStagingEntryInBootstrap } from "@/lib/record-summary";
import { useViewer } from "@/lib/viewer-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  describeLinkVisuals,
  originToMatrix4,
  parseUrdf,
  type UrdfJoint,
  type UrdfLink,
  type UrdfSpec,
  type UrdfVisual,
} from "@/components/viewer3d/urdf-parser";

type Severity = "ok" | "warning" | "critical";
type Category = "joint" | "axis" | "range" | "collision" | "semantic" | "hierarchy";
type SaveMode = "overwrite" | "new_version";
type Vec3 = [number, number, number];
type PreservedVisualOrigin = { xyz: Vec3; rpy: Vec3 };

type CollisionSupport = {
  available: boolean;
  summary: string;
  detail: string;
  compileCommand: string | null;
} | null;

type CollisionHit = {
  joint: UrdfJoint;
  linkName: string;
  proxyLabel: string;
  distance: number;
  threshold: number;
};

type Candidate = {
  id: string;
  sourceLink: string;
  targetLink: string;
  jointName: string;
  visualIndex: number;
  visualLabel: string;
  visualName: string | null;
  meshFilename: string | null;
  evidence: string;
};

type Patch = Candidate & {
  capturedPose: number | null;
  preservedOrigin: PreservedVisualOrigin | null;
};

type Issue = {
  id: string;
  category: Category;
  severity: Severity;
  title: string;
  target: string;
  evidence: string;
  action: string;
  relatedJoint?: string;
  candidate?: Candidate;
};

type DiagnosticsPanelProps = {
  urdfSpec: { joints: UrdfJoint[] } | null;
  jointValues: Map<string, number>;
  onJointChange: (name: string, value: number) => void;
  collisionSupport: CollisionSupport;
};

const CATEGORY_LABELS: Record<Category, string> = {
  joint: "Joint Type",
  axis: "Axis / Origin",
  range: "Range",
  collision: "Collision",
  semantic: "Semantic",
  hierarchy: "Hierarchy",
};

const OUTLIER_VISUAL_RE = /outlier/i;
const ORIGINAL_PART_VISUAL_RE = /(?:^|[/\\_-])original[-_]?\d+(?:\.|$)/i;
const PROXY_FALLBACK_RADIUS = 0.035;
const PROXY_CONTACT_MARGIN = 0.006;

function SeverityBadge({ severity, label }: { severity: Severity; label?: string }): JSX.Element {
  const variant = severity === "critical" ? "destructive" : severity === "warning" ? "warning" : "success";
  return <Badge variant={variant}>{label ?? severity}</Badge>;
}

function SectionLabel({ children }: { children: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2 pb-2">
      <span className="text-[10px] font-medium uppercase tracking-[0.05em] text-[var(--text-tertiary)]">
        {children}
      </span>
      <div className="h-px flex-1 bg-[var(--border-subtle)]" />
    </div>
  );
}

function isMovable(joint: UrdfJoint): boolean {
  return !joint.mimic && (joint.type === "revolute" || joint.type === "continuous" || joint.type === "prismatic");
}

function severityRank(severity: Severity): number {
  return severity === "critical" ? 2 : severity === "warning" ? 1 : 0;
}

function addIssue(issues: Issue[], issue: Omit<Issue, "id">): void {
  issues.push({ ...issue, id: `${issue.category}-${issues.length + 1}` });
}

function limitSpan(joint: UrdfJoint): number | null {
  const lower = joint.limit?.lower;
  const upper = joint.limit?.upper;
  if (
    typeof lower !== "number" ||
    typeof upper !== "number" ||
    !Number.isFinite(lower) ||
    !Number.isFinite(upper) ||
    upper <= lower
  ) {
    return null;
  }
  return upper - lower;
}

function jointRange(joint: UrdfJoint): [number, number] {
  if (joint.type === "continuous") return [-Math.PI, Math.PI];
  const lower = joint.limit?.lower;
  const upper = joint.limit?.upper;
  if (typeof lower === "number" && typeof upper === "number" && upper > lower) {
    return [lower, upper];
  }
  return joint.type === "prismatic" ? [-0.12, 0.12] : [-Math.PI / 3, Math.PI / 3];
}

function poseLabel(joint: UrdfJoint | undefined, value: number | null | undefined): string {
  if (!joint || value == null) return "neutral";
  if (joint.type === "revolute" || joint.type === "continuous") {
    return `${(value * 180 / Math.PI).toFixed(1)} deg`;
  }
  return `${value.toFixed(3)} m`;
}

function cleanNumber(value: number): number {
  return Math.abs(value) < 1e-10 ? 0 : Number(value.toPrecision(12));
}

function matrixToOrigin(matrix: THREE.Matrix4): PreservedVisualOrigin {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  const euler = new THREE.Euler().setFromQuaternion(quaternion, "XYZ");
  return {
    xyz: [cleanNumber(position.x), cleanNumber(position.y), cleanNumber(position.z)],
    rpy: [cleanNumber(euler.x), cleanNumber(euler.y), cleanNumber(euler.z)],
  };
}

function jointMotionMatrix(joint: UrdfJoint, value: number | undefined): THREE.Matrix4 {
  const amount = value ?? 0;
  if (!isMovable(joint) || Math.abs(amount) < 1e-12) return new THREE.Matrix4();
  const axisTuple = joint.axis ?? [1, 0, 0];
  const axis = new THREE.Vector3(axisTuple[0], axisTuple[1], axisTuple[2]);
  if (axis.lengthSq() < 1e-12) return new THREE.Matrix4();
  axis.normalize();
  if (joint.type === "prismatic") {
    return new THREE.Matrix4().makeTranslation(axis.x * amount, axis.y * amount, axis.z * amount);
  }
  return new THREE.Matrix4().makeRotationAxis(axis, amount);
}

function rootLinks(spec: UrdfSpec): Set<string> {
  const children = new Set(spec.joints.map((joint) => joint.child));
  return new Set(
    spec.links
      .map((link) => link.name)
      .filter((name) => !children.has(name) || /base|root|world|ground/i.test(name)),
  );
}

function linkWorldTransforms(spec: UrdfSpec, jointValues: Map<string, number>): Map<string, THREE.Matrix4> {
  const transforms = new Map<string, THREE.Matrix4>();
  for (const root of rootLinks(spec)) transforms.set(root, new THREE.Matrix4());

  let pending = [...spec.joints];
  let madeProgress = true;
  while (pending.length > 0 && madeProgress) {
    madeProgress = false;
    const next: UrdfJoint[] = [];
    for (const joint of pending) {
      const parentTransform = transforms.get(joint.parent);
      if (!parentTransform) {
        next.push(joint);
        continue;
      }
      const originTransform = originToMatrix4(joint.origin);
      const motionTransform = jointMotionMatrix(joint, jointValues.get(joint.name));
      const parentToChild = new THREE.Matrix4().multiplyMatrices(originTransform, motionTransform);
      const childTransform = new THREE.Matrix4().multiplyMatrices(parentTransform, parentToChild);
      transforms.set(joint.child, childTransform);
      madeProgress = true;
    }
    pending = next;
  }

  return transforms;
}

function descendantsForLink(spec: UrdfSpec, rootLinkName: string): Set<string> {
  const descendants = new Set<string>([rootLinkName]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const joint of spec.joints) {
      if (descendants.has(joint.parent) && !descendants.has(joint.child)) {
        descendants.add(joint.child);
        changed = true;
      }
    }
  }
  return descendants;
}

function proxyRadius(geometry: UrdfVisual["geometry"]): number {
  if (geometry.type === "sphere") return Math.max(geometry.radius ?? PROXY_FALLBACK_RADIUS, PROXY_FALLBACK_RADIUS);
  if (geometry.type === "cylinder") {
    const radius = geometry.radius ?? PROXY_FALLBACK_RADIUS;
    const halfLength = (geometry.length ?? PROXY_FALLBACK_RADIUS * 2) / 2;
    return Math.max(Math.hypot(radius, halfLength), PROXY_FALLBACK_RADIUS);
  }
  if (geometry.type === "box") {
    const size = geometry.size ?? [PROXY_FALLBACK_RADIUS * 2, PROXY_FALLBACK_RADIUS * 2, PROXY_FALLBACK_RADIUS * 2];
    return Math.max(Math.hypot(size[0] / 2, size[1] / 2, size[2] / 2), PROXY_FALLBACK_RADIUS);
  }
  const scale = geometry.scale ?? [1, 1, 1];
  return Math.max(Math.max(Math.abs(scale[0]), Math.abs(scale[1]), Math.abs(scale[2])) * PROXY_FALLBACK_RADIUS, PROXY_FALLBACK_RADIUS);
}

function itemWorldPosition(linkName: string, item: UrdfVisual, transforms: Map<string, THREE.Matrix4>): THREE.Vector3 | null {
  const linkWorld = transforms.get(linkName);
  if (!linkWorld) return null;
  const itemWorld = new THREE.Matrix4().multiplyMatrices(linkWorld, originToMatrix4(item.origin));
  return new THREE.Vector3().setFromMatrixPosition(itemWorld);
}

function linkByName(spec: UrdfSpec): Map<string, UrdfLink> {
  return new Map(spec.links.map((link) => [link.name, link]));
}

function isOriginalPartVisual(text: string): boolean {
  return ORIGINAL_PART_VISUAL_RE.test(text);
}

function collisionHitForVisual(
  spec: UrdfSpec,
  sourceLink: UrdfLink,
  visual: UrdfVisual,
  childJoints: UrdfJoint[],
  transforms: Map<string, THREE.Matrix4>,
): CollisionHit | null {
  const visualPosition = itemWorldPosition(sourceLink.name, visual, transforms);
  if (!visualPosition) return null;
  const visualRadius = proxyRadius(visual.geometry);
  const links = linkByName(spec);
  let best: CollisionHit | null = null;
  let bestOverlap = -Infinity;

  for (const joint of childJoints) {
    const descendants = descendantsForLink(spec, joint.child);
    for (const linkName of descendants) {
      if (linkName === sourceLink.name) continue;
      const link = links.get(linkName);
      if (!link || link.collisions.length === 0) continue;
      for (const descriptor of describeLinkVisuals({ ...link, visuals: link.collisions })) {
        const collision = link.collisions[descriptor.index];
        const collisionPosition = itemWorldPosition(linkName, collision, transforms);
        if (!collisionPosition) continue;
        const threshold = visualRadius + proxyRadius(collision.geometry) + PROXY_CONTACT_MARGIN;
        const distance = visualPosition.distanceTo(collisionPosition);
        const overlap = threshold - distance;
        if (overlap >= 0 && overlap > bestOverlap) {
          bestOverlap = overlap;
          best = { joint, linkName, proxyLabel: descriptor.label, distance, threshold };
        }
      }
    }
  }

  return best;
}

function preservedOriginForReparent(
  spec: UrdfSpec,
  candidate: Candidate,
  jointValues: Map<string, number>,
  capturedPose: number | null,
): PreservedVisualOrigin | null {
  const valuesAtCapture = new Map(jointValues);
  if (capturedPose != null) valuesAtCapture.set(candidate.jointName, capturedPose);

  const sourceLink = spec.links.find((link) => link.name === candidate.sourceLink);
  const visual = sourceLink?.visuals[candidate.visualIndex];
  if (!visual) return null;

  const transforms = linkWorldTransforms(spec, valuesAtCapture);
  const sourceWorld = transforms.get(candidate.sourceLink);
  const targetWorld = transforms.get(candidate.targetLink);
  if (!sourceWorld || !targetWorld) return null;

  const visualWorld = new THREE.Matrix4().multiplyMatrices(sourceWorld, originToMatrix4(visual.origin));
  const visualInTarget = new THREE.Matrix4().multiplyMatrices(targetWorld.clone().invert(), visualWorld);
  return matrixToOrigin(visualInTarget);
}

function inspectJoint(joint: UrdfJoint, issues: Issue[]): void {
  if (!joint.parent || !joint.child) {
    addIssue(issues, {
      category: "hierarchy",
      severity: "critical",
      title: "Missing parent or child link",
      target: joint.name,
      evidence: "The joint is missing one side of its kinematic connection.",
      action: "Repair parent and child link references.",
      relatedJoint: joint.name,
    });
  }
  if (joint.parent && joint.parent === joint.child) {
    addIssue(issues, {
      category: "hierarchy",
      severity: "critical",
      title: "Self-referential joint",
      target: joint.name,
      evidence: `${joint.parent} is both parent and child.`,
      action: "Split geometry into separate links or remove the invalid joint.",
      relatedJoint: joint.name,
    });
  }

  const name = joint.name.toLowerCase();
  if (/hinge|pivot|door|lid|rotate/.test(name) && joint.type === "prismatic") {
    addIssue(issues, {
      category: "joint",
      severity: "critical",
      title: "Sliding joint used for rotational part",
      target: joint.name,
      evidence: "Name suggests hinge-like rotation, but type is prismatic.",
      action: "Use revolute or continuous.",
      relatedJoint: joint.name,
    });
  }
  if (/drawer|slide|slider/.test(name) && (joint.type === "revolute" || joint.type === "continuous")) {
    addIssue(issues, {
      category: "joint",
      severity: "critical",
      title: "Rotational joint used for sliding part",
      target: joint.name,
      evidence: "Name suggests linear travel, but type is rotational.",
      action: "Use prismatic with valid limits.",
      relatedJoint: joint.name,
    });
  }
  if (joint.type === "floating" || joint.type === "planar") {
    addIssue(issues, {
      category: "joint",
      severity: "warning",
      title: "Unsupported sweep joint type",
      target: joint.name,
      evidence: `${joint.type} cannot be shown as a one-axis sweep.`,
      action: "Prefer revolute, continuous, or prismatic.",
      relatedJoint: joint.name,
    });
  }
  if (!isMovable(joint)) return;

  const axis = joint.axis;
  const axisLength = axis ? Math.hypot(axis[0], axis[1], axis[2]) : null;
  if (axisLength == null) {
    addIssue(issues, {
      category: "axis",
      severity: "warning",
      title: "Implicit joint axis",
      target: joint.name,
      evidence: "No explicit axis vector is present.",
      action: "Declare an axis for motion review.",
      relatedJoint: joint.name,
    });
  } else if (axisLength < 0.01) {
    addIssue(issues, {
      category: "axis",
      severity: "critical",
      title: "Degenerate joint axis",
      target: joint.name,
      evidence: `Axis length is ${axisLength.toExponential(2)}.`,
      action: "Use a normalized non-zero axis.",
      relatedJoint: joint.name,
    });
  } else if (Math.abs(axisLength - 1) > 0.05) {
    addIssue(issues, {
      category: "axis",
      severity: "warning",
      title: "Joint axis is not normalized",
      target: joint.name,
      evidence: `Axis length is ${axisLength.toFixed(3)} instead of 1.0.`,
      action: "Normalize the axis vector.",
      relatedJoint: joint.name,
    });
  }

  if (!joint.origin?.xyz && !/(base|root|world|ground)/i.test(`${joint.parent} ${joint.child}`)) {
    addIssue(issues, {
      category: "axis",
      severity: "warning",
      title: "Pivot origin may be under-specified",
      target: joint.name,
      evidence: "Joint origin is omitted for a non-root connection.",
      action: "Verify pivot placement.",
      relatedJoint: joint.name,
    });
  }

  const span = limitSpan(joint);
  if (joint.type !== "continuous" && span == null) {
    addIssue(issues, {
      category: "range",
      severity: "critical",
      title: "Invalid or missing range",
      target: joint.name,
      evidence: "Lower and upper limits are absent, equal, inverted, or non-finite.",
      action: "Set valid lower and upper bounds.",
      relatedJoint: joint.name,
    });
  } else if (span != null && joint.type === "revolute" && span > Math.PI * 2 + 0.01) {
    addIssue(issues, {
      category: "range",
      severity: "warning",
      title: "Revolute range exceeds one full turn",
      target: joint.name,
      evidence: `Range is ${((span * 180) / Math.PI).toFixed(1)} degrees.`,
      action: "Use continuous or tighten hinge limits.",
      relatedJoint: joint.name,
    });
  } else if (span != null && joint.type === "prismatic" && span > 2) {
    addIssue(issues, {
      category: "range",
      severity: "warning",
      title: "Prismatic travel is very large",
      target: joint.name,
      evidence: `Travel is ${span.toFixed(2)} m.`,
      action: "Check object scale and slider limits.",
      relatedJoint: joint.name,
    });
  }
}

function visualCandidates(spec: UrdfSpec, jointValues: Map<string, number>, collisionSupport: CollisionSupport): Candidate[] {
  const movableByParent = new Map<string, UrdfJoint[]>();
  for (const joint of spec.joints.filter(isMovable)) {
    const list = movableByParent.get(joint.parent) ?? [];
    list.push(joint);
    movableByParent.set(joint.parent, list);
  }

  const transforms = linkWorldTransforms(spec, jointValues);
  const candidates: Candidate[] = [];
  for (const link of spec.links) {
    const childJoints = movableByParent.get(link.name) ?? [];
    if (childJoints.length === 0) continue;

    for (const descriptor of describeLinkVisuals(link)) {
      const visual = link.visuals[descriptor.index];
      if (!visual) continue;
      const meshFilename = visual.geometry.type === "mesh" ? visual.geometry.filename ?? null : null;
      const text = [descriptor.label, visual.name, meshFilename].filter(Boolean).join(" ");
      const lowerText = text.toLowerCase();
      const collisionHit = collisionHitForVisual(spec, link, visual, childJoints, transforms);
      const namedJoint = childJoints.find(
        (joint) => lowerText.includes(joint.child.toLowerCase()) || lowerText.includes(joint.name.toLowerCase()),
      );
      const targetJoint = collisionHit?.joint ?? namedJoint ?? childJoints[0];
      const movedPose = Math.abs(jointValues.get(targetJoint.name) ?? 0) > 0.001;
      const outlierName = OUTLIER_VISUAL_RE.test(text);
      const originalPartName = isOriginalPartVisual(text);

      if (!outlierName && !collisionHit) continue;
      if (!outlierName && originalPartName) continue;

      const evidence = [
        `Visual ${descriptor.label} is attached to ${link.name}.`,
        outlierName ? "Name contains outlier." : null,
        collisionHit
          ? `Collision proxy overlaps ${collisionHit.linkName} / ${collisionHit.proxyLabel}; estimated distance ${collisionHit.distance.toFixed(4)} <= ${collisionHit.threshold.toFixed(4)}.`
          : null,
        `Candidate movable child is ${targetJoint.child} through ${targetJoint.name}.`,
        movedPose
          ? `Current ${targetJoint.name} pose is ${poseLabel(targetJoint, jointValues.get(targetJoint.name))}.`
          : "Move the joint away from neutral to confirm whether this visual should follow it.",
        collisionSupport?.available ? "Collision geometry is available for this asset." : null,
      ]
        .filter(Boolean)
        .join(" ");

      candidates.push({
        id: `${link.name}:${descriptor.index}:${targetJoint.child}`,
        sourceLink: link.name,
        targetLink: targetJoint.child,
        jointName: targetJoint.name,
        visualIndex: descriptor.index,
        visualLabel: descriptor.label,
        visualName: visual.name ?? null,
        meshFilename,
        evidence,
      });
    }
  }
  return candidates;
}

function buildIssues(spec: UrdfSpec, jointValues: Map<string, number>, collisionSupport: CollisionSupport): Issue[] {
  const issues: Issue[] = [];
  if (spec.joints.length === 0) {
    addIssue(issues, {
      category: "joint",
      severity: "critical",
      title: "No articulated joints detected",
      target: "URDF",
      evidence: "The viewer exposes no joints to diagnose.",
      action: "Compile or regenerate with explicit movable joints.",
    });
  }

  for (const joint of spec.joints) inspectJoint(joint, issues);

  if (collisionSupport && !collisionSupport.available) {
    addIssue(issues, {
      category: "collision",
      severity: "warning",
      title: "Collision evidence unavailable",
      target: "collision geometry",
      evidence: collisionSupport.summary,
      action: collisionSupport.compileCommand
        ? `Run ${collisionSupport.compileCommand}`
        : "Compile collision geometry before final acceptance.",
    });
  }

  for (const candidate of visualCandidates(spec, jointValues, collisionSupport)) {
    addIssue(issues, {
      category: "hierarchy",
      severity: "critical",
      title: "Visual may be assigned to the wrong link",
      target: `${candidate.sourceLink} / ${candidate.visualLabel}`,
      evidence: candidate.evidence,
      action: `Move ${candidate.visualLabel} to ${candidate.targetLink}, preserving its observed pose, then re-run diagnostics.`,
      relatedJoint: candidate.jointName,
      candidate,
    });
  }

  return issues.sort((left, right) => severityRank(right.severity) - severityRank(left.severity));
}

function applyPatches(spec: UrdfSpec, patches: Patch[]): UrdfSpec {
  const links = spec.links.map((link) => ({
    ...link,
    visuals: [...link.visuals],
    collisions: [...link.collisions],
  }));
  const byName = new Map(links.map((link) => [link.name, link]));

  for (const patch of [...patches].sort((a, b) => a.sourceLink.localeCompare(b.sourceLink) || b.visualIndex - a.visualIndex)) {
    const source = byName.get(patch.sourceLink);
    const target = byName.get(patch.targetLink);
    const visual = source?.visuals[patch.visualIndex];
    if (!source || !target || !visual) continue;
    source.visuals.splice(patch.visualIndex, 1);
    target.visuals.push(patch.preservedOrigin ? { ...visual, origin: patch.preservedOrigin } : visual);
  }

  return { ...spec, links };
}

function issueDismissKey(issue: Issue): string {
  return issue.candidate ? `candidate:${issue.candidate.id}` : `${issue.category}:${issue.title}:${issue.target}`;
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: unknown; message?: unknown };
    if (typeof payload.detail === "string") return payload.detail;
    if (typeof payload.message === "string") return payload.message;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
  return `${response.status} ${response.statusText}`;
}

export function DiagnosticsPanel({ urdfSpec, jointValues, onJointChange, collisionSupport }: DiagnosticsPanelProps): JSX.Element {
  const { bootstrap, selection } = useViewer();
  const [fetchedSpec, setFetchedSpec] = useState<UrdfSpec | null>(null);
  const [committedSpec, setCommittedSpec] = useState<UrdfSpec | null>(null);
  const [patches, setPatches] = useState<Patch[]>([]);
  const [dismissedIssues, setDismissedIssues] = useState<Set<string>>(() => new Set());
  const [status, setStatus] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const stagingEntry = selection?.kind === "staging" ? findStagingEntryInBootstrap(bootstrap, selection.runId, selection.recordId) : null;
  const selectionKey =
    selection?.kind === "record"
      ? `record:${selection.recordId}`
      : selection?.kind === "staging"
        ? `staging:${selection.runId}:${selection.recordId}`
        : "none";

  useEffect(() => {
    setPatches([]);
    setCommittedSpec(null);
    setDismissedIssues(new Set());
    setStatus(null);
  }, [selectionKey]);

  useEffect(() => {
    let cancelled = false;
    setFetchedSpec(null);
    if (!selection) return () => { cancelled = true; };

    const request = selection.kind === "record"
      ? fetchRecordFile(selection.recordId, "model.urdf")
      : fetchStagingFile(selection.runId, selection.recordId, "model.urdf");
    request
      .then((text) => {
        if (!cancelled) setFetchedSpec(parseUrdf(text));
      })
      .catch(() => {
        if (!cancelled) setFetchedSpec(null);
      });

    return () => { cancelled = true; };
  }, [reload, selection, selectionKey, stagingEntry]);

  const baseSpec = committedSpec ?? fetchedSpec ?? (urdfSpec ? { name: "viewer", links: [], joints: urdfSpec.joints } : null);
  const patchedSpec = useMemo(() => (baseSpec ? applyPatches(baseSpec, patches) : null), [baseSpec, patches]);
  const rawIssues = useMemo(
    () => (patchedSpec ? buildIssues(patchedSpec, jointValues, collisionSupport) : []),
    [collisionSupport, jointValues, patchedSpec],
  );
  const issues = useMemo(
    () => rawIssues.filter((issue) => !dismissedIssues.has(issueDismissKey(issue))),
    [dismissedIssues, rawIssues],
  );
  const critical = issues.filter((issue) => issue.severity === "critical").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;
  const score = Math.min(100, critical * 24 + warnings * 10);
  const overall: Severity = critical > 0 || score >= 70 ? "critical" : warnings > 0 ? "warning" : "ok";
  const joints = patchedSpec?.joints ?? [];
  const movable = joints.filter(isMovable);

  const rerunDiagnostics = (): void => {
    setDismissedIssues(new Set());
    setReload((value) => value + 1);
  };

  const dismissIssue = (issue: Issue): void => {
    setDismissedIssues((current) => {
      const next = new Set(current);
      next.add(issueDismissKey(issue));
      return next;
    });
  };

  const queueCandidate = (candidate: Candidate): void => {
    const capturedPose = jointValues.get(candidate.jointName) ?? null;
    const preservedOrigin = patchedSpec
      ? preservedOriginForReparent(patchedSpec, candidate, jointValues, capturedPose)
      : null;
    setPatches((current) =>
      current.some((patch) => patch.id === candidate.id)
        ? current
        : [...current, { ...candidate, capturedPose, preservedOrigin }],
    );
  };

  const save = async (mode: SaveMode): Promise<void> => {
    if (selection?.kind !== "record" || patches.length === 0 || !patchedSpec) return;
    setStatus("Saving...");
    const response = await fetch(`/api/records/${encodeURIComponent(selection.recordId)}/visual-reassignments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        moves: patches.map((patch) => ({
          source_link: patch.sourceLink,
          target_link: patch.targetLink,
          visual_index: patch.visualIndex,
          visual_name: patch.visualName,
          origin_xyz: patch.preservedOrigin?.xyz,
          origin_rpy: patch.preservedOrigin?.rpy,
          reason: patch.evidence,
        })),
      }),
    });
    if (!response.ok) {
      setStatus(await readError(response));
      return;
    }
    const payload = (await response.json()) as { applied_count: number; version_file_path: string };
    if (mode === "overwrite") {
      setCommittedSpec(patchedSpec);
      setPatches([]);
      setStatus(`Applied ${payload.applied_count} pose-preserving move(s) to active URDF. Refresh the viewer to render the rewritten file.`);
    } else {
      setStatus(`Saved diagnostic version: ${payload.version_file_path}`);
    }
  };

  if (!selection) {
    return <div className="flex h-32 items-center justify-center"><p className="text-[11px] text-[var(--text-quaternary)]">Select a record</p></div>;
  }

  return (
    <ScrollArea className="h-full min-w-0">
      <div className="min-w-0 space-y-5 pb-3">
        <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {overall === "critical" ? <ShieldAlert className="size-4 text-[var(--destructive)]" /> : overall === "warning" ? <AlertTriangle className="size-4 text-[var(--warning)]" /> : <CheckCircle2 className="size-4 text-[var(--success)]" />}
                <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">Diagnostic HUD</h3>
              </div>
              <p className="mt-1 text-[11px] leading-[1.5] text-[var(--text-tertiary)]">
                Classifies articulation errors, gives target/evidence/action, and supports iterative visual-link reassignment.
              </p>
            </div>
            <div className="text-right">
              <SeverityBadge severity={overall} label={overall === "critical" ? "Likely Error" : overall === "warning" ? "Needs Inspection" : "Looks Consistent"} />
              <p className="mt-1 font-mono text-[18px] font-semibold text-[var(--text-primary)]">{score}</p>
              <p className="text-[9.5px] text-[var(--text-quaternary)]">risk score</p>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-4 gap-2 text-center">
            <Metric label="joints" value={joints.length} />
            <Metric label="movable" value={movable.length} />
            <Metric label="critical" value={critical} />
            <Metric label="warnings" value={warnings} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={rerunDiagnostics}>
              <RefreshCw className="mr-1 size-3" /> Re-run
            </Button>
            {patches.length ? <Badge>{patches.length} pending</Badge> : null}
            {dismissedIssues.size ? <Badge>{dismissedIssues.size} ignored</Badge> : null}
          </div>
        </section>

        <section>
          <SectionLabel>Error taxonomy</SectionLabel>
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(CATEGORY_LABELS) as Category[]).map((category) => {
              const bucket = issues.filter((issue) => issue.category === category);
              const severity = bucket.reduce<Severity>(
                (current, issue) => (severityRank(issue.severity) > severityRank(current) ? issue.severity : current),
                "ok",
              );
              return (
                <div key={category} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[11px] font-medium text-[var(--text-primary)]">{CATEGORY_LABELS[category]}</span>
                    <SeverityBadge severity={severity} label={bucket.length ? String(bucket.length) : "OK"} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section>
          <SectionLabel>Top evidence</SectionLabel>
          {issues.length === 0 ? (
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] px-3 py-3 text-[11px] text-[var(--text-tertiary)]">
              No deterministic diagnostic issues detected.
            </div>
          ) : (
            <div className="space-y-2">
              {issues.slice(0, 6).map((issue) => (
                <IssueCard key={issue.id} issue={issue} onApply={queueCandidate} onDismiss={dismissIssue} />
              ))}
            </div>
          )}
        </section>

        <section>
          <SectionLabel>Motion timeline</SectionLabel>
          <div className="space-y-2">
            {movable.length === 0 ? (
              <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] px-3 py-3 text-[11px] text-[var(--text-tertiary)]">
                No movable sweep.
              </div>
            ) : (
              movable.map((joint) => {
                const [min, max] = jointRange(joint);
                const mid = (min + max) / 2;
                const issue = issues.find((item) => item.relatedJoint === joint.name);
                const severity = issue?.severity ?? "ok";
                const value = jointValues.get(joint.name) ?? 0;
                return (
                  <div key={joint.name} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[11px] text-[var(--text-primary)]">{joint.type}: {joint.name}</span>
                      <SeverityBadge severity={severity} label={severity === "ok" ? "clear" : severity} />
                    </div>
                    <p className="mt-2 text-[10.5px] leading-[1.45] text-[var(--text-tertiary)]">
                      {issue?.evidence ?? `Current pose ${poseLabel(joint, value)}.`}
                    </p>
                    <div className="mt-2 flex gap-1.5">
                      <Button type="button" variant="outline" size="sm" onClick={() => onJointChange(joint.name, min)}>min</Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => onJointChange(joint.name, mid)}>mid</Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => onJointChange(joint.name, max)}>max</Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section>
          <SectionLabel>Repair queue</SectionLabel>
          {patches.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--border-subtle)] bg-[var(--surface-1)] px-3 py-3 text-[11px] leading-[1.5] text-[var(--text-tertiary)]">
              Move a joint to a revealing pose, apply a suggested visual move, then diagnostics re-run against a pose-preserving patched URDF.
            </div>
          ) : (
            <div className="space-y-2">
              {patches.map((patch) => (
                <div key={patch.id} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] px-3 py-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-[11px] font-semibold text-[var(--text-primary)]">
                        {patch.visualLabel}: {patch.sourceLink}{" -> "}{patch.targetLink}
                      </p>
                      <p className="mt-1 text-[10.5px] text-[var(--text-tertiary)]">
                        Captured {patch.jointName}: {poseLabel(joints.find((joint) => joint.name === patch.jointName), patch.capturedPose)} · {patch.preservedOrigin ? "pose preserved" : "origin fallback"}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setPatches((current) => current.filter((item) => item.id !== patch.id))}
                    >
                      Undo
                    </Button>
                  </div>
                </div>
              ))}
              <div className="grid grid-cols-2 gap-2">
                <Button type="button" size="sm" disabled={selection.kind !== "record"} onClick={() => { void save("overwrite"); }}>
                  Overwrite
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={selection.kind !== "record"} onClick={() => { void save("new_version"); }}>
                  Save version
                </Button>
              </div>
              {selection.kind !== "record" ? (
                <p className="text-[10.5px] text-[var(--text-quaternary)]">Saving is enabled after this staging item is persisted.</p>
              ) : null}
              {status ? <p className="text-[10.5px] leading-[1.45] text-[var(--text-tertiary)]">{status}</p> : null}
            </div>
          )}
        </section>
      </div>
    </ScrollArea>
  );
}

function Metric({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="rounded-lg bg-[var(--surface-0)] px-2 py-2">
      <p className="font-mono text-[14px] font-semibold text-[var(--text-primary)]">{value}</p>
      <p className="text-[9.5px] text-[var(--text-quaternary)]">{label}</p>
    </div>
  );
}

function IssueCard({ issue, onApply, onDismiss }: { issue: Issue; onApply: (candidate: Candidate) => void; onDismiss: (issue: Issue) => void }): JSX.Element {
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-semibold text-[var(--text-primary)]">{issue.title}</p>
          <p className="mt-1 font-mono text-[10px] text-[var(--text-quaternary)]">{issue.target}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" title="Ignore this error" onClick={() => onDismiss(issue)}>
            ❌
          </Button>
          <SeverityBadge severity={issue.severity} />
        </div>
      </div>
      <p className="mt-2 text-[10.5px] leading-[1.45] text-[var(--text-secondary)]"><span className="font-medium">Evidence:</span> {issue.evidence}</p>
      <p className="mt-1 text-[10.5px] leading-[1.45] text-[var(--text-tertiary)]"><span className="font-medium">Action:</span> {issue.action}</p>
      {issue.candidate ? (
        <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => onApply(issue.candidate!)}>
          Move visual to {issue.candidate.targetLink}
        </Button>
      ) : null}
    </div>
  );
}

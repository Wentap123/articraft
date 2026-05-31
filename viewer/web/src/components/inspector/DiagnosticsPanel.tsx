import { useEffect, useMemo, useState, type JSX } from "react";
import { AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";

import { fetchRecordFile, fetchStagingFile } from "@/lib/api";
import { findStagingEntryInBootstrap } from "@/lib/record-summary";
import { useViewer } from "@/lib/viewer-context";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import type { UrdfJoint } from "@/components/inspector/JointSlider";

type Severity = "ok" | "warning" | "critical";
type Category = "joint" | "axis" | "range" | "collision" | "semantic" | "hierarchy";

type CollisionSupport = {
  available: boolean;
  summary: string;
  detail: string;
  compileCommand: string | null;
} | null;

type Issue = {
  id: string;
  category: Category;
  severity: Severity;
  title: string;
  target: string;
  evidence: string;
  action: string;
};

type Requirement = {
  label: string;
  terms: string[];
  modelTerms: string[];
  jointTypes?: Array<UrdfJoint["type"]>;
};

type DiagnosticsPanelProps = {
  urdfSpec: { joints: UrdfJoint[] } | null;
  jointValues: Map<string, number>;
  collisionSupport: CollisionSupport;
};

const CATEGORY_LABELS: Record<Category, string> = {
  joint: "Joint Type Error",
  axis: "Axis / Origin Error",
  range: "Range Error",
  collision: "Collision Error",
  semantic: "Semantic Mismatch",
  hierarchy: "Hierarchy Integrity",
};

const REQUIREMENTS: Requirement[] = [
  { label: "Safety rails / guards", terms: ["safety rail", "guard rail", "rail", "guard"], modelTerms: ["rail", "guard", "barrier"] },
  { label: "Door / lid hinge", terms: ["door", "lid", "hatch", "hinge"], modelTerms: ["door", "lid", "hatch", "hinge"], jointTypes: ["revolute", "continuous"] },
  { label: "Drawer / slide", terms: ["drawer", "slide", "sliding"], modelTerms: ["drawer", "slide", "slider"], jointTypes: ["prismatic"] },
  { label: "Wheel / caster", terms: ["wheel", "caster", "rolling"], modelTerms: ["wheel", "caster", "axle"], jointTypes: ["continuous", "revolute"] },
  { label: "Handle / grip", terms: ["handle", "grip", "knob", "lever"], modelTerms: ["handle", "grip", "knob", "lever"] },
  { label: "Adjustable articulation", terms: ["adjustable", "articulated", "hinged", "rotating", "tilting"], modelTerms: ["joint", "hinge", "pivot", "tilt", "arm"], jointTypes: ["revolute", "continuous", "prismatic"] },
];

function SectionLabel({ children }: { children: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2 pb-2">
      <span className="text-[10px] font-medium uppercase tracking-[0.05em] text-[var(--text-tertiary)]">{children}</span>
      <div className="h-px flex-1 bg-[var(--border-subtle)]" />
    </div>
  );
}

function SeverityBadge({ severity, label }: { severity: Severity; label?: string }): JSX.Element {
  const variant = severity === "critical" ? "destructive" : severity === "warning" ? "warning" : "success";
  return <Badge variant={variant}>{label ?? severity}</Badge>;
}

function isMovable(joint: UrdfJoint): boolean {
  return !joint.mimic && (joint.type === "revolute" || joint.type === "continuous" || joint.type === "prismatic");
}

function severityRank(severity: Severity): number {
  return severity === "critical" ? 2 : severity === "warning" ? 1 : 0;
}

function vecLen(axis: [number, number, number] | undefined): number | null {
  if (!axis || axis.some((value) => !Number.isFinite(value))) return null;
  return Math.hypot(axis[0], axis[1], axis[2]);
}

function limitSpan(joint: UrdfJoint): number | null {
  const lower = joint.limit?.lower;
  const upper = joint.limit?.upper;
  if (typeof lower !== "number" || typeof upper !== "number") return null;
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower) return null;
  return upper - lower;
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term.toLowerCase()));
}

function corpus(joints: UrdfJoint[]): string {
  return joints.flatMap((joint) => [joint.name, joint.parent, joint.child]).join(" ").toLowerCase();
}

function addIssue(issues: Issue[], issue: Omit<Issue, "id">): void {
  issues.push({ ...issue, id: `${issue.category}-${issues.length + 1}` });
}

function inspectJoint(joint: UrdfJoint, issues: Issue[]): void {
  if (!joint.parent || !joint.child) {
    addIssue(issues, { category: "hierarchy", severity: "critical", title: "Missing parent or child link", target: joint.name || "unnamed joint", evidence: "The joint is missing one side of its kinematic connection.", action: "Repair the URDF parent and child link references." });
  }
  if (joint.parent && joint.parent === joint.child) {
    addIssue(issues, { category: "hierarchy", severity: "critical", title: "Self-referential joint", target: joint.name, evidence: `${joint.parent} is both parent and child.`, action: "Split the geometry into separate links or remove the invalid joint." });
  }

  const name = joint.name.toLowerCase();
  if (/hinge|pivot|door|lid|rotate/.test(name) && joint.type === "prismatic") {
    addIssue(issues, { category: "joint", severity: "critical", title: "Sliding joint used for rotational part", target: joint.name, evidence: "Name suggests hinge-like rotation, but the type is prismatic.", action: "Use a revolute or continuous joint." });
  }
  if (/drawer|slide|slider/.test(name) && (joint.type === "revolute" || joint.type === "continuous")) {
    addIssue(issues, { category: "joint", severity: "critical", title: "Rotational joint used for sliding part", target: joint.name, evidence: "Name suggests linear travel, but the type is rotational.", action: "Use a prismatic joint with valid travel limits." });
  }
  if (joint.type === "floating" || joint.type === "planar") {
    addIssue(issues, { category: "joint", severity: "warning", title: "Unsupported diagnostic joint type", target: joint.name, evidence: `${joint.type} cannot be shown as a one-axis motion sweep.`, action: "Prefer revolute, continuous, or prismatic joints for generated assets." });
  }

  if (!isMovable(joint)) return;

  const axisLength = vecLen(joint.axis);
  if (axisLength == null) {
    addIssue(issues, { category: "axis", severity: "warning", title: "Implicit joint axis", target: joint.name, evidence: "No explicit axis vector is present.", action: "Declare an axis so reviewers can audit motion direction." });
  } else if (axisLength < 0.01) {
    addIssue(issues, { category: "axis", severity: "critical", title: "Degenerate joint axis", target: joint.name, evidence: `Axis length is ${axisLength.toExponential(2)}.`, action: "Use a normalized non-zero axis vector." });
  } else if (Math.abs(axisLength - 1) > 0.05) {
    addIssue(issues, { category: "axis", severity: "warning", title: "Joint axis is not normalized", target: joint.name, evidence: `Axis length is ${axisLength.toFixed(3)} instead of 1.0.`, action: "Normalize the axis vector." });
  }

  if (!joint.origin?.xyz && !/(base|root|world|ground)/i.test(`${joint.parent} ${joint.child}`)) {
    addIssue(issues, { category: "axis", severity: "warning", title: "Pivot origin may be under-specified", target: joint.name, evidence: "The joint origin is omitted for a non-root connection.", action: "Verify the pivot is placed at the physical hinge, slider, or axle." });
  }

  const range = limitSpan(joint);
  if (joint.type !== "continuous" && range == null) {
    addIssue(issues, { category: "range", severity: "critical", title: "Invalid or missing range", target: joint.name, evidence: "Lower and upper limits are absent, equal, inverted, or non-finite.", action: "Set valid lower and upper bounds." });
  } else if (range != null && joint.type === "revolute" && range > Math.PI * 2 + 0.01) {
    addIssue(issues, { category: "range", severity: "warning", title: "Revolute range exceeds one full turn", target: joint.name, evidence: `Range is ${(range * 180 / Math.PI).toFixed(1)} degrees.`, action: "Use continuous for free rotation or tighten hinge limits." });
  } else if (range != null && joint.type === "prismatic" && range > 2) {
    addIssue(issues, { category: "range", severity: "warning", title: "Prismatic travel is very large", target: joint.name, evidence: `Travel is ${range.toFixed(2)} m.`, action: "Check object scale and slider limits." });
  }
}

function buildIssues(joints: UrdfJoint[], promptText: string | null, collisionSupport: CollisionSupport): Issue[] {
  const issues: Issue[] = [];
  if (joints.length === 0) {
    addIssue(issues, { category: "joint", severity: "critical", title: "No articulated joints detected", target: "URDF", evidence: "The viewer exposes no joints to diagnose.", action: "Compile or regenerate with explicit movable joints." });
  }

  for (const joint of joints) inspectJoint(joint, issues);

  if (collisionSupport && !collisionSupport.available) {
    addIssue(issues, { category: "collision", severity: "warning", title: "Collision evidence unavailable", target: "collision geometry", evidence: collisionSupport.summary, action: collisionSupport.compileCommand ? `Run ${collisionSupport.compileCommand}` : "Compile or persist collision geometry before final acceptance." });
  }

  if (promptText?.trim()) {
    const prompt = promptText.toLowerCase();
    const modelText = corpus(joints);
    for (const requirement of REQUIREMENTS.filter((item) => containsAny(prompt, item.terms))) {
      const named = containsAny(modelText, requirement.modelTerms);
      const motion = requirement.jointTypes ? joints.some((joint) => isMovable(joint) && requirement.jointTypes?.includes(joint.type)) : true;
      if (!named && !motion) {
        addIssue(issues, { category: "semantic", severity: "critical", title: "Prompt requirement missing", target: requirement.label, evidence: "No matching part name or compatible motion was found.", action: "Add the missing functional geometry or regenerate with stricter constraints." });
      } else if (!named || !motion) {
        addIssue(issues, { category: "semantic", severity: "warning", title: "Prompt requirement partially matched", target: requirement.label, evidence: "Only part of the expected semantic or motion evidence is present.", action: "Manually inspect whether the requirement is actually satisfied." });
      }
    }
  }

  return issues.sort((left, right) => severityRank(right.severity) - severityRank(left.severity));
}

function formatPose(joint: UrdfJoint, value: number | undefined): string {
  if (value == null) return "No current pose value.";
  if (joint.type === "revolute" || joint.type === "continuous") return `Current pose ${(value * 180 / Math.PI).toFixed(1)} degrees.`;
  return `Current pose ${value.toFixed(3)} m.`;
}

export function DiagnosticsPanel({ urdfSpec, jointValues, collisionSupport }: DiagnosticsPanelProps): JSX.Element {
  const { bootstrap, selectedRecordId, selection } = useViewer();
  const [promptText, setPromptText] = useState<string | null>(null);
  const [promptStatus, setPromptStatus] = useState<"idle" | "loading" | "loaded" | "unavailable">("idle");
  const stagingEntry = selection?.kind === "staging" ? findStagingEntryInBootstrap(bootstrap, selection.runId, selection.recordId) : null;
  const joints = useMemo(() => urdfSpec?.joints ?? [], [urdfSpec?.joints]);
  const issues = useMemo(() => buildIssues(joints, promptText, collisionSupport), [collisionSupport, joints, promptText]);
  const criticalCount = issues.filter((issue) => issue.severity === "critical").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const score = Math.min(100, criticalCount * 24 + warningCount * 10);
  const overall: Severity = criticalCount > 0 || score >= 70 ? "critical" : warningCount > 0 ? "warning" : "ok";
  const movableJoints = joints.filter(isMovable);

  useEffect(() => {
    let cancelled = false;
    setPromptText(null);

    if (selection?.kind === "staging" && stagingEntry) {
      if (!stagingEntry.has_prompt) {
        setPromptStatus("unavailable");
        return;
      }
      setPromptStatus("loading");
      fetchStagingFile(stagingEntry.run_id, stagingEntry.record_id, "prompt.txt")
        .then((text) => {
          if (cancelled) return;
          const normalized = text.trim();
          setPromptText(normalized || null);
          setPromptStatus(normalized ? "loaded" : "unavailable");
        })
        .catch(() => { if (!cancelled) setPromptStatus("unavailable"); });
      return () => { cancelled = true; };
    }

    if (selection?.kind === "record" && selectedRecordId) {
      setPromptStatus("loading");
      fetchRecordFile(selectedRecordId, "prompt.txt")
        .then((text) => {
          if (cancelled) return;
          const normalized = text.trim();
          setPromptText(normalized || null);
          setPromptStatus(normalized ? "loaded" : "unavailable");
        })
        .catch(() => { if (!cancelled) setPromptStatus("unavailable"); });
      return () => { cancelled = true; };
    }

    setPromptStatus("idle");
    return () => { cancelled = true; };
  }, [selectedRecordId, selection, stagingEntry]);

  if (!selection) {
    return (
      <div className="flex h-32 items-center justify-center">
        <p className="text-[11px] text-[var(--text-quaternary)]">Select a record</p>
      </div>
    );
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
              <p className="mt-1 text-[11px] leading-[1.5] text-[var(--text-tertiary)]">Error taxonomy, evidence trail, motion timeline, collision status, and prompt consistency checks.</p>
            </div>
            <div className="text-right">
              <SeverityBadge severity={overall} label={overall === "critical" ? "Likely Error" : overall === "warning" ? "Needs Inspection" : "Looks Consistent"} />
              <p className="mt-1 font-mono text-[18px] font-semibold text-[var(--text-primary)]">{score}</p>
              <p className="text-[9.5px] text-[var(--text-quaternary)]">risk score</p>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-4 gap-2 text-center">
            <Metric label="joints" value={joints.length} />
            <Metric label="movable" value={movableJoints.length} />
            <Metric label="critical" value={criticalCount} />
            <Metric label="warnings" value={warningCount} />
          </div>
        </section>

        <section>
          <SectionLabel>Error taxonomy</SectionLabel>
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(CATEGORY_LABELS) as Category[]).map((category) => {
              const categoryIssues = issues.filter((issue) => issue.category === category);
              const severity = categoryIssues.reduce<Severity>((current, issue) => severityRank(issue.severity) > severityRank(current) ? issue.severity : current, "ok");
              return <div key={category} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] px-2.5 py-2"><div className="flex items-center justify-between gap-2"><span className="truncate text-[11px] font-medium text-[var(--text-primary)]">{CATEGORY_LABELS[category]}</span><SeverityBadge severity={severity} label={categoryIssues.length ? String(categoryIssues.length) : "OK"} /></div></div>;
            })}
          </div>
        </section>

        <section>
          <SectionLabel>Top evidence</SectionLabel>
          {issues.length === 0 ? <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] px-3 py-3 text-[11px] text-[var(--text-tertiary)]">No deterministic diagnostic issues detected.</div> : <div className="space-y-2">{issues.slice(0, 5).map((issue) => <IssueCard key={issue.id} issue={issue} />)}</div>}
        </section>

        <section>
          <SectionLabel>Motion timeline</SectionLabel>
          <div className="space-y-2">
            {(movableJoints.length > 0 ? movableJoints : [null]).map((joint) => {
              const issue = joint ? issues.find((candidate) => candidate.target === joint.name) : null;
              const severity = issue?.severity ?? (joint ? "ok" : overall);
              return (
                <div key={joint?.name ?? "no-motion"} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2"><span className="truncate font-mono text-[11px] text-[var(--text-primary)]">{joint ? `${joint.type}: ${joint.name}` : "No movable sweep"}</span><SeverityBadge severity={severity} label={severity === "ok" ? "clear" : severity} /></div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-3)]"><div className={`h-full rounded-full ${severity === "critical" ? "bg-[var(--destructive)]" : severity === "warning" ? "bg-[var(--warning)]" : "bg-[var(--success)]"}`} style={{ width: "100%" }} /></div>
                  <p className="mt-2 text-[10.5px] leading-[1.45] text-[var(--text-tertiary)]">{issue?.evidence ?? (joint ? formatPose(joint, jointValues.get(joint.name)) : "No revolute, continuous, or prismatic joint is available for timeline review.")}</p>
                </div>
              );
            })}
          </div>
        </section>

        <section>
          <SectionLabel>Prompt consistency</SectionLabel>
          {promptStatus === "loading" ? <div className="space-y-1.5"><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-[88%]" /></div> : promptText ? <p className="line-clamp-5 whitespace-pre-wrap break-words rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] px-3 py-2 text-[11px] leading-[1.55] text-[var(--text-secondary)]">{promptText}</p> : <p className="text-[11px] text-[var(--text-quaternary)]">Prompt unavailable</p>}
        </section>

        <section>
          <SectionLabel>Decision workflow</SectionLabel>
          <div className="space-y-2">
            {[
              ["Inspect hierarchy", "Confirm parent and child links form a valid tree."],
              ["Verify axes and origins", "Check pivots, axis vectors, and suspicious missing origins."],
              ["Sweep motion", "Use the timeline to review range and type errors."],
              ["Review collision evidence", collisionSupport?.available ? collisionSupport.detail : collisionSupport?.summary ?? "Collision status is unavailable."],
              ["Accept or repair", overall === "critical" ? "Repair or regenerate before accepting." : overall === "warning" ? "Manual inspection recommended before accepting." : "Candidate is ready for normal review."],
            ].map(([label, description], index) => <div key={label} className="flex gap-2 rounded-lg bg-[var(--surface-1)] px-3 py-2"><div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--surface-3)] font-mono text-[10px] text-[var(--text-secondary)]">{index + 1}</div><div className="min-w-0"><p className="text-[11px] font-medium text-[var(--text-primary)]">{label}</p><p className="mt-0.5 text-[10.5px] leading-[1.45] text-[var(--text-tertiary)]">{description}</p></div></div>)}
          </div>
        </section>
      </div>
    </ScrollArea>
  );
}

function Metric({ label, value }: { label: string; value: number }): JSX.Element {
  return <div className="rounded-lg bg-[var(--surface-0)] px-2 py-2"><p className="font-mono text-[14px] font-semibold text-[var(--text-primary)]">{value}</p><p className="text-[9.5px] text-[var(--text-quaternary)]">{label}</p></div>;
}

function IssueCard({ issue }: { issue: Issue }): JSX.Element {
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] px-3 py-2.5">
      <div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate text-[11px] font-semibold text-[var(--text-primary)]">{issue.title}</p><p className="mt-1 font-mono text-[10px] text-[var(--text-quaternary)]">{issue.target}</p></div><SeverityBadge severity={issue.severity} /></div>
      <p className="mt-2 text-[10.5px] leading-[1.45] text-[var(--text-secondary)]"><span className="font-medium">Evidence:</span> {issue.evidence}</p>
      <p className="mt-1 text-[10.5px] leading-[1.45] text-[var(--text-tertiary)]"><span className="font-medium">Action:</span> {issue.action}</p>
    </div>
  );
}

import type {
  CategoryOption,
  CostFilter,
  DashboardData,
  DatasetEntry,
  DeleteStagingResult,
  DeleteRecordResult,
  HydrateRecordResult,
  OpenRecordFolderResult,
  OpenStagingFolderResult,
  RecordHistory,
  RecordBrowseIdsResponse,
  RecordBrowseResponse,
  RecordRatingResponse,
  RecordSecondaryRatingResponse,
  RecordSummary,
  RepoStats,
  RatingFilter,
  RunDetail,
  SourceFilter,
  StagingEntry,
  TimeFilter,
  ViewerBootstrap,
} from "@/lib/types";

export interface RecordTextFileResult {
  record_id: string;
  file_path: string;
  content: string;
  truncated: boolean;
  byte_count: number;
  preview_byte_limit: number | null;
}

type TextFileOptions = {
  full?: boolean;
  previewBytes?: number;
};

type RecordFilterParams = {
  source: SourceFilter;
  query: string;
  runId?: string | null;
  timeFilter: TimeFilter;
  modelFilter: string | null;
  sdkFilter: string | null;
  agentHarnessFilters: string[];
  authorFilters: string[];
  categoryFilters: string[];
  costFilter: CostFilter;
  ratingFilter: RatingFilter;
  secondaryRatingFilter: RatingFilter;
};

export class HttpError extends Error {
  readonly status: number;
  readonly statusText: string;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.statusText = message;
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `${response.status} ${response.statusText}`;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return fallback;
  }

  try {
    const payload = (await response.json()) as { detail?: unknown; message?: unknown };
    if (typeof payload.detail === "string" && payload.detail.trim()) {
      return payload.detail;
    }
    if (typeof payload.message === "string" && payload.message.trim()) {
      return payload.message;
    }
  } catch {
    return fallback;
  }

  return fallback;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    throw new HttpError(response.status, await readErrorMessage(response));
  }
  return (await response.json()) as T;
}

async function fetchText(path: string, init?: RequestInit): Promise<string> {
  const response = await fetch(path, init);
  if (!response.ok) {
    throw new HttpError(response.status, await readErrorMessage(response));
  }
  return response.text();
}

function textFileQuery(options?: TextFileOptions): string {
  const params = new URLSearchParams();
  if (options?.full) params.set("full", "true");
  if (options?.previewBytes != null) params.set("preview_bytes", String(options.previewBytes));
  const query = params.toString();
  return query ? `?${query}` : "";
}

function appendRecordFilters(searchParams: URLSearchParams, params: RecordFilterParams): void {
  searchParams.set("source", params.source);
  if (params.query.trim()) searchParams.set("q", params.query.trim());
  if (params.runId) searchParams.set("run_id", params.runId);
  if (params.timeFilter.oldest) searchParams.set("time_from", params.timeFilter.oldest);
  if (params.timeFilter.newest) searchParams.set("time_to", params.timeFilter.newest);
  if (params.modelFilter) searchParams.set("model", params.modelFilter);
  if (params.sdkFilter) searchParams.set("sdk", params.sdkFilter);
  for (const agentHarnessFilter of params.agentHarnessFilters) {
    searchParams.append("agent_harness", agentHarnessFilter);
  }
  for (const authorFilter of params.authorFilters) {
    searchParams.append("author", authorFilter);
  }
  for (const categoryFilter of params.categoryFilters) {
    searchParams.append("category", categoryFilter);
  }
  if (params.costFilter.min != null) searchParams.set("cost_min", String(params.costFilter.min));
  if (params.costFilter.max != null) searchParams.set("cost_max", String(params.costFilter.max));
  for (const rating of params.ratingFilter) {
    searchParams.append("rating", rating);
  }
  for (const rating of params.secondaryRatingFilter) {
    searchParams.append("secondary_rating", rating);
  }
}

export async function fetchBootstrap(): Promise<ViewerBootstrap> {
  return fetchJson<ViewerBootstrap>("/api/bootstrap?include_dataset_entries=false");
}

export async function fetchRepoStats(): Promise<RepoStats> {
  return fetchJson<RepoStats>("/api/stats");
}

export async function fetchDashboard(
  params: {
    timeFilter: TimeFilter;
    starsFilter: [number, number];
    costFilter: CostFilter;
    sdkFilter: string | null;
    agentHarnessFilters: string[];
    authorFilters: string[];
    categoryFilters: string[];
    rollingWindowDays: number;
  },
  init?: RequestInit,
): Promise<DashboardData> {
  const searchParams = new URLSearchParams();
  if (params.timeFilter.oldest) {
    searchParams.set("time_from", params.timeFilter.oldest);
  }
  if (params.timeFilter.newest) {
    searchParams.set("time_to", params.timeFilter.newest);
  }
  if (params.starsFilter[0] > 0) {
    searchParams.set("stars_min", String(params.starsFilter[0]));
  }
  if (params.starsFilter[1] < 5) {
    searchParams.set("stars_max", String(params.starsFilter[1]));
  }
  if (params.costFilter.min != null) {
    searchParams.set("cost_min", String(params.costFilter.min));
  }
  if (params.costFilter.max != null) {
    searchParams.set("cost_max", String(params.costFilter.max));
  }
  if (params.sdkFilter) {
    searchParams.set("sdk", params.sdkFilter);
  }
  for (const agentHarnessFilter of params.agentHarnessFilters) {
    searchParams.append("agent_harness", agentHarnessFilter);
  }
  for (const authorFilter of params.authorFilters) {
    searchParams.append("author", authorFilter);
  }
  for (const categoryFilter of params.categoryFilters) {
    searchParams.append("category", categoryFilter);
  }
  searchParams.set("rolling_window_days", String(params.rollingWindowDays));
  return fetchJson<DashboardData>(`/api/dashboard?${searchParams.toString()}`, init);
}

export async function fetchDatasetEntries(): Promise<DatasetEntry[]> {
  return fetchJson<DatasetEntry[]>("/api/collections/dataset");
}

export async function fetchCategories(): Promise<CategoryOption[]> {
  return fetchJson<CategoryOption[]>("/api/categories");
}

export async function fetchStagingEntries(): Promise<StagingEntry[]> {
  return fetchJson<StagingEntry[]>("/api/staging");
}

export async function fetchRecordSummary(recordId: string): Promise<RecordSummary | null> {
  return fetchJson<RecordSummary | null>(`/api/records/${encodeURIComponent(recordId)}/summary`);
}

export async function fetchRecordDetail(recordId: string) {
  return fetchJson(`/api/records/${encodeURIComponent(recordId)}`);
}

export async function fetchRecordTextFile(
  recordId: string,
  filePath: string,
  options?: TextFileOptions,
): Promise<RecordTextFileResult> {
  return fetchJson<RecordTextFileResult>(
    `/api/records/${encodeURIComponent(recordId)}/text/${encodeURIComponent(filePath)}${textFileQuery(options)}`,
  );
}

export async function fetchStagingTextFile(
  runId: string,
  recordId: string,
  filePath: string,
  options?: TextFileOptions,
): Promise<RecordTextFileResult> {
  return fetchJson<RecordTextFileResult>(
    `/api/staging/${encodeURIComponent(runId)}/${encodeURIComponent(recordId)}/text/${encodeURIComponent(filePath)}${textFileQuery(options)}`,
  );
}

export async function fetchRecordFile(recordId: string, filePath: string): Promise<string> {
  return (await fetchRecordTextFile(recordId, filePath, { full: true })).content;
}

export async function fetchStagingFile(runId: string, recordId: string, filePath: string): Promise<string> {
  return (await fetchStagingTextFile(runId, recordId, filePath, { full: true })).content;
}

export async function fetchRecordTraceFile(recordId: string, filePath: string): Promise<string> {
  return fetchText(`/api/records/${encodeURIComponent(recordId)}/traces/${encodeURIComponent(filePath)}`);
}

export async function fetchStagingTraceFile(runId: string, recordId: string, filePath: string): Promise<string> {
  return fetchText(`/api/staging/${encodeURIComponent(runId)}/${encodeURIComponent(recordId)}/traces/${encodeURIComponent(filePath)}`);
}

export async function browseRecords(params: RecordFilterParams & {
  limit: number;
  offset: number;
}): Promise<RecordBrowseResponse> {
  const searchParams = new URLSearchParams();
  appendRecordFilters(searchParams, params);
  searchParams.set("limit", String(params.limit));
  searchParams.set("offset", String(params.offset));
  return fetchJson<RecordBrowseResponse>(`/api/records/browse?${searchParams.toString()}`);
}

export async function fetchBrowseRecordIds(params: RecordFilterParams): Promise<RecordBrowseIdsResponse> {
  const searchParams = new URLSearchParams();
  appendRecordFilters(searchParams, params);
  return fetchJson<RecordBrowseIdsResponse>(`/api/records/browse/ids?${searchParams.toString()}`);
}

export async function searchRecords(params: RecordFilterParams & {
  limit: number;
}): Promise<RecordSummary[]> {
  const searchParams = new URLSearchParams();
  appendRecordFilters(searchParams, params);
  searchParams.set("limit", String(params.limit));
  return fetchJson<RecordSummary[]>(`/api/records/search?${searchParams.toString()}`);
}

export async function rateRecord(recordId: string, rating: number): Promise<RecordRatingResponse> {
  return fetchJson<RecordRatingResponse>(`/api/records/${encodeURIComponent(recordId)}/rating`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating }),
  });
}

export const saveRecordRating = rateRecord;

export async function rateRecordSecondary(recordId: string, rating: number | null): Promise<RecordSecondaryRatingResponse> {
  return fetchJson<RecordSecondaryRatingResponse>(`/api/records/${encodeURIComponent(recordId)}/secondary-rating`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating }),
  });
}

export const saveRecordSecondaryRating = rateRecordSecondary;

export async function hydrateRecord(recordId: string): Promise<HydrateRecordResult> {
  return fetchJson<HydrateRecordResult>(`/api/records/${encodeURIComponent(recordId)}/hydrate`, { method: "POST" });
}

export async function deleteRecord(recordId: string): Promise<DeleteRecordResult> {
  return fetchJson<DeleteRecordResult>(`/api/records/${encodeURIComponent(recordId)}`, { method: "DELETE" });
}

export async function deleteStaging(runId: string, recordId: string): Promise<DeleteStagingResult> {
  return fetchJson<DeleteStagingResult>(
    `/api/staging/${encodeURIComponent(runId)}/${encodeURIComponent(recordId)}`,
    { method: "DELETE" },
  );
}

export const deleteStagingEntry = deleteStaging;

export async function promoteRecordToDataset(
  recordId: string,
  payload: { categorySlug: string; categoryTitle: string; datasetId?: string | null },
): Promise<DatasetEntry> {
  return fetchJson<DatasetEntry>(`/api/records/${encodeURIComponent(recordId)}/promote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      category_slug: payload.categorySlug,
      category_title: payload.categoryTitle,
      dataset_id: payload.datasetId?.trim() || null,
    }),
  });
}

export async function openRecordFolder(recordId: string): Promise<OpenRecordFolderResult> {
  return fetchJson<OpenRecordFolderResult>(`/api/records/${encodeURIComponent(recordId)}/open-folder`, { method: "POST" });
}

export async function openStagingFolder(runId: string, recordId: string): Promise<OpenStagingFolderResult> {
  return fetchJson<OpenStagingFolderResult>(
    `/api/staging/${encodeURIComponent(runId)}/${encodeURIComponent(recordId)}/open-folder`,
    { method: "POST" },
  );
}

export async function fetchRecordHistory(recordId: string): Promise<RecordHistory> {
  return fetchJson<RecordHistory>(`/api/records/${encodeURIComponent(recordId)}/history`);
}

export async function fetchRunDetail(runId: string): Promise<RunDetail> {
  return fetchJson<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
}

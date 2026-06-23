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

export async function fetchRecordFile(recordId: string, filePath: string): Promise<string> {
  const result = await fetchJson<RecordTextFileResult>(
    `/api/records/${encodeURIComponent(recordId)}/files/${encodeURIComponent(filePath)}`,
  );
  return result.content;
}

export async function fetchStagingFile(runId: string, recordId: string, filePath: string): Promise<string> {
  const result = await fetchJson<RecordTextFileResult>(
    `/api/staging/${encodeURIComponent(runId)}/${encodeURIComponent(recordId)}/files/${encodeURIComponent(filePath)}`,
  );
  return result.content;
}

export async function browseRecords(params: {
  source: SourceFilter;
  query: string;
  limit: number;
  offset: number;
  timeFilter: TimeFilter;
  modelFilter: string | null;
  sdkFilter: string | null;
  agentHarnessFilters: string[];
  authorFilters: string[];
  categoryFilters: string[];
  costFilter: CostFilter;
  ratingFilter: RatingFilter;
  secondaryRatingFilter: RatingFilter;
}): Promise<RecordBrowseResponse> {
  const searchParams = new URLSearchParams();
  searchParams.set("source", params.source);
  searchParams.set("limit", String(params.limit));
  searchParams.set("offset", String(params.offset));
  if (params.query.trim()) searchParams.set("q", params.query.trim());
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
  return fetchJson<RecordBrowseResponse>(`/api/records?${searchParams.toString()}`);
}

export async function fetchBrowseRecordIds(params: {
  source: SourceFilter;
  query: string;
  timeFilter: TimeFilter;
  modelFilter: string | null;
  sdkFilter: string | null;
  agentHarnessFilters: string[];
  authorFilters: string[];
  categoryFilters: string[];
  costFilter: CostFilter;
  ratingFilter: RatingFilter;
  secondaryRatingFilter: RatingFilter;
}): Promise<RecordBrowseIdsResponse> {
  const searchParams = new URLSearchParams();
  searchParams.set("source", params.source);
  if (params.query.trim()) searchParams.set("q", params.query.trim());
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
  return fetchJson<RecordBrowseIdsResponse>(`/api/records/ids?${searchParams.toString()}`);
}

export async function searchRecords(params: {
  source: SourceFilter;
  query: string;
  limit: number;
  timeFilter: TimeFilter;
  modelFilter: string | null;
  sdkFilter: string | null;
  agentHarnessFilters: string[];
  authorFilters: string[];
  categoryFilters: string[];
  costFilter: CostFilter;
  ratingFilter: RatingFilter;
  secondaryRatingFilter: RatingFilter;
}): Promise<RecordBrowseResponse> {
  return browseRecords({
    ...params,
    offset: 0,
  });
}

export async function rateRecord(recordId: string, rating: number): Promise<RecordRatingResponse> {
  return fetchJson<RecordRatingResponse>(`/api/records/${encodeURIComponent(recordId)}/rating`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating }),
  });
}

export async function rateRecordSecondary(recordId: string, rating: number | null): Promise<RecordSecondaryRatingResponse> {
  return fetchJson<RecordSecondaryRatingResponse>(`/api/records/${encodeURIComponent(recordId)}/secondary-rating`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating }),
  });
}

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

import type { Dispatch } from "react";

import {
  ViewerProvider,
  useViewer,
} from "./viewer-context.tsx";
import type { ViewerAction } from "@/lib/types";

export { ViewerProvider, useViewer };

export function useViewerDispatch(): Dispatch<ViewerAction> {
  return useViewer().dispatch;
}

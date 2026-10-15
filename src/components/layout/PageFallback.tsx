/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { Skeleton } from "@/components/ui/Controls";

export function PageFallback() {
  return (
    <div className="page-loading" aria-busy>
      <Skeleton width={180} height={16} />
      <Skeleton width="60%" />
      <Skeleton width="40%" />
    </div>
  );
}

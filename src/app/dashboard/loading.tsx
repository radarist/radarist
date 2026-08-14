import { SmartLayout } from "@/components/layout/AppLayoutV2";
import { DashboardSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <SmartLayout>
      <DashboardSkeleton />
    </SmartLayout>
  );
}

import { SmartLayout } from "@/components/layout/AppLayoutV2";
import { RadarSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <SmartLayout>
      <RadarSkeleton />
    </SmartLayout>
  );
}

import { SmartLayout } from "@/components/layout/AppLayoutV2";
import { SignalsSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <SmartLayout>
      <SignalsSkeleton />
    </SmartLayout>
  );
}

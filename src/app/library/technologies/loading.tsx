import { SmartLayout } from "@/components/layout/AppLayoutV2";
import { DataTableSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <SmartLayout>
      <DataTableSkeleton rows={10} columns={5} />
    </SmartLayout>
  );
}

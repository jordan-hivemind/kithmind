import { Suspense } from "react";

import { FamilySpaceManager } from "@/components/family-space-manager";

export default function SpacesPage() {
  return (
    <Suspense fallback={<p>Loading...</p>}>
      <FamilySpaceManager />
    </Suspense>
  );
}

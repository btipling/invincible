/**
 * Plan #960 firewall — explicit view/partial guard on CLOUD transcript paths.
 * Meta-only preferences (model / reasoning / queue mirror) ride the narrow
 * PATCH channel instead of a transcript write. The marker is the snapshot's
 * explicit `historyComplete` field, never length inference.
 */
export function assertCompleteForCloudPut(snapshot: { historyComplete?: boolean }): void {
  if (snapshot.historyComplete === false) {
    throw new Error(
      'snapshot has historyComplete:false — view only (blocked from transcript put by the partial-view firewall)',
    );
  }
}
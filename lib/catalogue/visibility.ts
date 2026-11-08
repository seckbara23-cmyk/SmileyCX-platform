/**
 * What the public interface shows of the V8 catalogue — XP-LAUNCH-FINAL-08.
 *
 * Requirements V4 (Marième, 2026-10-14, confirmed 2026-11-08): the nine job-role
 * pathways (PM-*) and six industry pathways (SEC-*) stay CONFIGURED in the database,
 * with their V8 compositions, but are hidden from visitors at launch: no navigation
 * entry, no « Cette formation fait partie des parcours » section, no public pathway
 * page, nothing in the sitemap. The launch offer is individual courses and three
 * commercial offers (Pack Conseiller, Pack Manager, Pack Entreprises).
 *
 * Nothing is deleted. Turning this back on restores every surface as it was.
 * Dependency-free so server and client components can both read it.
 */
export const PUBLIC_PATHWAYS_VISIBLE = false

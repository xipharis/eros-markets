import { introduction, gettingStarted } from "./start";

export const DOC_GROUPS = [introduction, gettingStarted];
/** Reading order: the sidebar order, which also drives previous / next links. */
export const DOC_PAGES = DOC_GROUPS.flatMap((g) => g.pages.map((p) => ({ ...p, group: g.title })));
export const docHref = (slug: string) => (slug ? `/docs/${slug}` : "/docs");

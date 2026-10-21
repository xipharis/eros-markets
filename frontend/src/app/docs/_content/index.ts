import { introduction, gettingStarted } from "./start";
import { trading } from "./trading";
import { risk } from "./risk";
import { lifecycle } from "./lifecycle";

export const DOC_GROUPS = [introduction, gettingStarted, trading, risk, lifecycle];
/** Reading order: the sidebar order, which also drives previous / next links. */
export const DOC_PAGES = DOC_GROUPS.flatMap((g) => g.pages.map((p) => ({ ...p, group: g.title })));
export const docHref = (slug: string) => (slug ? `/docs/${slug}` : "/docs");

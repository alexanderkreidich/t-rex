
export const WEB_LINK_TARGETS = ["tab", "panel"] as const;
export type WebLinkTarget = (typeof WEB_LINK_TARGETS)[number];


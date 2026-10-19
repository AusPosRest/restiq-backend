/**
 * CU-20 / restiq-backend#230: how far back "live" reaches. A ticket fired, or
 * an unclosed order opened, more than 12 hours ago is a leftover from an
 * earlier service - it stays in the data but no longer counts as live work:
 * off the KDS boards, and no longer marks its table busy or occupied.
 */
export const LIVE_WINDOW_MS = 12 * 60 * 60 * 1000

export const liveSince = (): Date => new Date(Date.now() - LIVE_WINDOW_MS)

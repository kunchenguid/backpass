/**
 * The one line every prompt backpass sends to a harness starts with.
 *
 * It lives in its own dependency-free module because two very different readers need
 * it: `src/prompts.js` (which prepends it, and which loads prompt files from disk) and
 * `src/discovery/self.js` (which detects it). The self check also has to run on a
 * remote host inside the shipped probe bundle (`src/discovery/remote/bundle.js`), where
 * dragging prompt loading along would pull in a directory of markdown for one constant.
 *
 * Why it exists at all: the harness records backpass's own prompt as the session's
 * first user message, in the very store discovery reads, so without a marker the next
 * run would analyze backpass talking to itself.
 */
export const SELF_SESSION_SENTINEL = "<!-- backpass:self-session -->";

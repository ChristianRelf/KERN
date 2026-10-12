"""Regenerates the syntax plugin catalog from a tm-grammars release.

Writes src/features/plugins/catalog.ts and src-tauri/src/domain/plugins_catalog.rs.
The grammar package is only read as text, never executed.

    mkdir tmp && cd tmp && npm pack tm-grammars@1.32.22 && tar xzf tm-grammars-1.32.22.tgz
    python scripts/gen-syntax-catalog.py tmp/package

When changing version, update TM_GRAMMARS_VERSION below as well.
"""

import hashlib
import json
import os
import re
import sys

TM_GRAMMARS_VERSION = "1.32.22"
PKG = sys.argv[1]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read_metadata(index_js):
    """Pulls the grammar list out of the package's generated index.js by pattern, without running it."""
    body = index_js[index_js.index('export const grammars = ['):]
    blocks = re.split(r'\n  \{\n', body)[1:]
    out = []
    def strs(block, key):
        m = re.search(r'\n    ' + key + r': \[\n(.*?)\n    \],', block, re.S)
        return re.findall(r"'([^']*)'", m.group(1)) if m else []
    def one(block, key):
        m = re.search(r'\n    ' + key + r": '([^']*)'", '\n' + block)
        return m.group(1) if m else None
    for b in blocks:
        b = b.split('\n  },')[0]
        size = re.search(r'byteSize: (\d+)', b)
        out.append({ 'name': one(b,'name'), 'displayName': one(b,'displayName'), 'scopeName': one(b,'scopeName'), 'byteSize': int(size.group(1)) if size else None, 'hash': one(b,'hash'), 'aliases': strs(b,'aliases'), 'embedded': strs(b,'embedded'), 'embeddedIn': strs(b,'embeddedIn'), 'license': one(b,'license') })
    return out


meta = {g['name']: g for g in read_metadata(open(os.path.join(PKG, 'index.js'), encoding='utf-8').read())}
gdir = os.path.join(PKG, 'grammars')

# id: (kind, extensions, lower-case file names)
CUR = {
    'typescript': ('code', 'ts mts cts', ''), 'tsx': ('code', 'tsx', ''), 'javascript': ('code', 'js mjs cjs', ''), 'jsx': ('code', 'jsx', ''),
    'json': ('data', 'json', ''), 'jsonc': ('data', 'jsonc', 'tsconfig.json jsconfig.json .eslintrc.json devcontainer.json'), 'json5': ('data', 'json5', ''),
    'html': ('code', 'html htm', ''), 'css': ('code', 'css', ''), 'scss': ('code', 'scss', ''), 'sass': ('code', 'sass', ''), 'less': ('code', 'less', ''),
    'markdown': ('data', 'md markdown', ''), 'mdx': ('code', 'mdx', ''), 'yaml': ('data', 'yml yaml', ''), 'toml': ('data', 'toml', ''),
    'xml': ('data', 'xml xsd xsl plist csproj fsproj svg', ''), 'rust': ('code', 'rs', ''), 'python': ('code', 'py pyi pyw', ''), 'go': ('code', 'go', ''),
    'java': ('code', 'java', ''), 'kotlin': ('code', 'kt kts', ''), 'swift': ('code', 'swift', ''), 'c': ('code', 'c h', ''),
    'cpp': ('code', 'cpp cc cxx hpp hh hxx', ''), 'csharp': ('code', 'cs', ''), 'fsharp': ('code', 'fs fsi fsx', ''), 'php': ('code', 'php', ''),
    'ruby': ('code', 'rb rake gemspec', 'gemfile rakefile'), 'lua': ('code', 'lua', ''), 'dart': ('code', 'dart', ''),
    'shellscript': ('code', 'sh bash zsh', '.bashrc .zshrc .profile'), 'powershell': ('code', 'ps1 psm1 psd1', ''), 'bat': ('code', 'bat cmd', ''),
    'sql': ('code', 'sql', ''), 'graphql': ('code', 'graphql gql', ''), 'docker': ('data', 'dockerfile', 'dockerfile'), 'make': ('data', 'mk', 'makefile gnumakefile'),
    'vue': ('code', 'vue', ''), 'svelte': ('code', 'svelte', ''), 'astro': ('code', 'astro', ''), 'ini': ('data', 'ini cfg conf properties', '.editorconfig .gitconfig'),
    'diff': ('data', 'diff patch', ''), 'haskell': ('code', 'hs lhs', ''), 'elixir': ('code', 'ex exs', ''), 'erlang': ('code', 'erl hrl', ''),
    'scala': ('code', 'scala sc', ''), 'clojure': ('code', 'clj cljs cljc edn', ''), 'zig': ('code', 'zig', ''), 'r': ('code', 'r', ''),
    'julia': ('code', 'jl', ''), 'perl': ('code', 'pl pm', ''), 'ocaml': ('code', 'ml mli', ''), 'nix': ('code', 'nix', ''),
    'terraform': ('code', 'tf tfvars', ''), 'hcl': ('data', 'hcl', ''), 'prisma': ('code', 'prisma', ''), 'proto': ('code', 'proto', ''),
    'latex': ('code', 'tex sty cls', ''), 'objective-c': ('code', 'm', ''), 'groovy': ('code', 'groovy gradle', ''), 'gleam': ('code', 'gleam', ''),
    'solidity': ('code', 'sol', ''), 'cmake': ('data', 'cmake', 'cmakelists.txt'), 'dotenv': ('data', '', '.env .env.local .env.example .env.development .env.production'),
    'vb': ('code', 'vb', ''), 'log': ('data', 'log', ''), 'handlebars': ('code', 'hbs handlebars', ''), 'pug': ('code', 'pug jade', ''),
    'coffee': ('code', 'coffee', ''), 'elm': ('code', 'elm', ''), 'nginx': ('data', '', 'nginx.conf'), 'viml': ('code', 'vim', '.vimrc'),
}


def closure(n, seen=None):
    seen = set() if seen is None else seen
    for e in meta[n]['embedded']:
        if e not in seen and e in meta:
            seen.add(e)
            closure(e, seen)
    return seen


entries = []
needed = set()
for gid, (kind, exts, names) in CUR.items():
    g = meta[gid]
    deps = closure(gid) - {gid}
    requires = sorted(deps) if len(deps) <= 4 else []
    optional = sorted(set(g['embedded']) - set(requires))
    needed.add(gid)
    needed.update(requires)
    size = sum(os.path.getsize(os.path.join(gdir, x + '.json')) for x in [gid] + requires)
    entries.append(dict(id=gid, name=g['displayName'], kind=kind, exts=exts.split(), names=names.split(), requires=requires, optional=optional, size=size, license=g['license']))

table = []
for n in sorted(needed):
    data = open(os.path.join(gdir, n + '.json'), 'rb').read()
    table.append((n, hashlib.sha256(data).hexdigest(), len(data), meta[n]['scopeName'], meta[n]['embedded']))


def obj(d):
    return '{ ' + ', '.join(f'{k}: {json.dumps(v)}' for k, v in d.items()) + ' }'


ts = [
    f'// Generated from tm-grammars@{TM_GRAMMARS_VERSION} metadata by scripts/gen-syntax-catalog.py;',
    '// do not edit by hand. The',
    '// backend (src-tauri/src/domain/plugins.rs) downloads each grammar and',
    '// checks it against the SHA-256 recorded in plugins_catalog.rs.',
    '',
    'export interface SyntaxPlugin {',
    '  id: string;',
    '  name: string;',
    '  /** "code" languages are suggested for projects; "data" formats only appear in the plugin list. */',
    '  kind: "code" | "data";',
    '  exts: string[];',
    '  /** Lower-case file names (Dockerfile, Makefile, …). */',
    '  names: string[];',
    '  /** Grammars installed alongside (embedded languages it needs). */',
    '  requires: string[];',
    '  /** Embedded languages used when they happen to be installed. */',
    '  optional: string[];',
    '  /** Download size in bytes, including required grammars. */',
    '  size: number;',
    '  license: string | null;',
    '}',
    '',
    'export const SYNTAXES: SyntaxPlugin[] = [',
]
ts += [f'  {obj(e)},' for e in entries]
ts += ['];', '', '/** TextMate scope and embedded languages for every downloadable grammar. */', 'export const GRAMMAR_META: Record<string, { scope: string; embedded: string[] }> = {']
ts += [f'  {json.dumps(n)}: {{ scope: {json.dumps(scope)}, embedded: {json.dumps(emb)} }},' for n, h, size, scope, emb in table]
ts.append('};')
open(os.path.join(ROOT, 'src', 'features', 'plugins', 'catalog.ts'), 'w', encoding='utf-8', newline='\n').write('\n'.join(ts) + '\n')

rs = [f'//! Generated from tm-grammars@{TM_GRAMMARS_VERSION} by scripts/gen-syntax-catalog.py; do not edit by hand.', '//! (grammar name, SHA-256 of the published file, size in bytes)', '', f'pub const TM_GRAMMARS_VERSION: &str = "{TM_GRAMMARS_VERSION}";', '', 'pub const GRAMMARS: &[(&str, &str, u64)] = &[']
rs += [f'    ("{n}", "{h}", {size}),' for n, h, size, *_ in table]
rs.append('];')
open(os.path.join(ROOT, 'src-tauri', 'src', 'domain', 'plugins_catalog.rs'), 'w', encoding='utf-8', newline='\n').write('\n'.join(rs) + '\n')
print(len(entries), 'plugins,', len(table), 'grammars')

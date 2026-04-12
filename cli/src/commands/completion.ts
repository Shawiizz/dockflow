/**
 * Shell completion command
 *
 * Generates shell completion scripts for Bash, Zsh, and Fish.
 * Command lists are discovered dynamically from the Commander program tree —
 * no manual maintenance needed when new commands are added.
 *
 * Usage:
 *   dockflow completion bash   >> ~/.bash_completion.d/dockflow
 *   dockflow completion zsh    > ~/.zfunc/_dockflow
 *   dockflow completion fish   > ~/.config/fish/completions/dockflow.fish
 */

import type { Command } from 'commander';
import { printBlank, printInfo, printRaw } from '../utils/output';
import { withErrorHandler } from '../utils/errors';

// ─── Dynamic command tree discovery ───────────────────────────────────────────

interface CommandTree {
  /** All top-level command names */
  topLevel: string[];
  /** Subcommand names per parent command (only for commands that have children) */
  subcommands: Record<string, string[]>;
}

function discoverCommands(program: Command): CommandTree {
  const topLevel: string[] = [];
  const subcommands: Record<string, string[]> = {};

  for (const cmd of program.commands) {
    const name = cmd.name();
    // Skip the auto-generated help command — it's always available via --help
    if (name === 'help') continue;
    topLevel.push(name);

    if (cmd.commands.length > 0) {
      subcommands[name] = cmd.commands
        .filter((sub) => sub.name() !== 'help')
        .map((sub) => sub.name());
    }
  }

  return { topLevel, subcommands };
}

// ─── Shell script generators ───────────────────────────────────────────────────

function bashScript(tree: CommandTree): string {
  const topJoined = tree.topLevel.join(' ');
  const subLines = Object.entries(tree.subcommands)
    .map(
      ([cmd, subs]) =>
        `        ${cmd}) COMPREPLY=( $(compgen -W "${subs.join(' ')}" -- "$cur") ) ;;`,
    )
    .join('\n');

  return `# Bash completion for dockflow
# Install:
#   mkdir -p ~/.bash_completion.d
#   dockflow completion bash > ~/.bash_completion.d/dockflow
#   echo 'source ~/.bash_completion.d/dockflow' >> ~/.bashrc

_dockflow_completion() {
    local cur prev
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"

    case "$prev" in
${subLines}
        *) COMPREPLY=( $(compgen -W "${topJoined}" -- "$cur") ) ;;
    esac
}

complete -F _dockflow_completion dockflow
`;
}

function zshScript(tree: CommandTree): string {
  const topJoined = tree.topLevel.join(' ');
  const subCases = Object.entries(tree.subcommands)
    .map(([cmd, subs]) => `      (${cmd}) _arguments '*: :(${subs.join(' ')})' ;;`)
    .join('\n');

  return `#compdef dockflow
# Zsh completion for dockflow
# Install:
#   mkdir -p ~/.zfunc
#   dockflow completion zsh > ~/.zfunc/_dockflow
#   # Add to ~/.zshrc (if not already present):
#   #   fpath=(~/.zfunc $fpath)
#   #   autoload -Uz compinit && compinit

_dockflow() {
  local state
  _arguments \\
    '(-v --verbose)'{-v,--verbose}'[Enable verbose output]' \\
    '--no-color[Disable colors]' \\
    '1: :->command' \\
    '*: :->subcommand'

  case $state in
    command)
      _arguments '*: :(${topJoined})'
      ;;
    subcommand)
      case \${words[2]} in
${subCases}
        *) _files ;;
      esac
      ;;
  esac
}

_dockflow "$@"
`;
}

function fishScript(tree: CommandTree): string {
  const topCompletions = tree.topLevel
    .map((cmd) => `complete -c dockflow -f -n '__fish_use_subcommand' -a '${cmd}'`)
    .join('\n');

  const subCompletions = Object.entries(tree.subcommands)
    .flatMap(([cmd, subs]) =>
      subs.map(
        (sub) =>
          `complete -c dockflow -f -n '__fish_seen_subcommand_from ${cmd}' -a '${sub}'`,
      ),
    )
    .join('\n');

  return `# Fish completion for dockflow
# Install: dockflow completion fish > ~/.config/fish/completions/dockflow.fish

function __fish_use_subcommand
    set -l cmd (commandline -poc)
    set -e cmd[1]
    for sub in $cmd
        if string match -q -- '-*' $sub
            continue
        end
        return 1
    end
    return 0
end

${topCompletions}

# Subcommand completions
${subCompletions}
`;
}

// ─── Command registration ──────────────────────────────────────────────────────

export function registerCompletionCommand(program: Command): void {
  program
    .command('completion [shell]')
    .description('Generate shell completion script (bash | zsh | fish)')
    .helpGroup('Other')
    .action(
      withErrorHandler(async (shell?: string) => {
        // Discover at action time — all commands are registered by then
        const tree = discoverCommands(program);
        const target = (shell ?? '').toLowerCase();

        switch (target) {
          case 'bash':
            printRaw(bashScript(tree));
            break;

          case 'zsh':
            printRaw(zshScript(tree));
            break;

          case 'fish':
            printRaw(fishScript(tree));
            break;

          default: {
            printInfo('Generate and install a shell completion script:');
            printBlank();
            printRaw('  Bash:');
            printRaw('    dockflow completion bash > ~/.bash_completion.d/dockflow');
            printRaw('    source ~/.bash_completion.d/dockflow');
            printBlank();
            printRaw('  Zsh:');
            printRaw('    dockflow completion zsh > ~/.zfunc/_dockflow');
            printRaw('    # Add to ~/.zshrc: fpath=(~/.zfunc $fpath) && autoload -Uz compinit && compinit');
            printBlank();
            printRaw('  Fish:');
            printRaw('    dockflow completion fish > ~/.config/fish/completions/dockflow.fish');
            printBlank();
          }
        }
      }),
    );
}

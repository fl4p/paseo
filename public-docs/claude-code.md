---
title: Claude Code
description: Run Claude Code in Paseo using your existing Claude plan.
nav: Claude Code
order: 23
category: Providers
---

# Claude Code

Paseo runs Claude Code through the official `claude` CLI using the Claude Agent SDK.

## Does Claude Code cost extra in Paseo?

No. Claude Code usage in Paseo counts against your normal Claude plan limits. It does not require a separate pool of Agent SDK credits.

You still need a Claude plan that includes Claude Code, and your plan's usual usage limits apply.

## Getting started

Install and sign in to the Claude Code CLI on the machine running Paseo. Paseo uses that existing installation and account when you start a Claude Code agent.

If your Claude login expires, re-authenticate with the Claude Code CLI, then start a new Claude Code session in Paseo. Existing Paseo sessions keep the authentication they started with, so re-authenticating does not update a session that is already running.

## Multiple subscription accounts

Sign in once per account on the machine running Paseo. Use a different configuration directory for each account:

```sh
CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude auth login
CLAUDE_CONFIG_DIR="$HOME/.claude-personal" claude auth login
```

Complete each login with the intended Anthropic account. Keep API credentials and API-key helpers out of these directories and your project settings when using subscriptions; Claude still loads those settings. Then merge these entries into `$PASEO_HOME/config.json` (normally `~/.paseo/config.json`):

```json
{
  "agents": {
    "providers": {
      "claude": {
        "params": {
          "accounts": {
            "work": { "label": "Work", "configDir": "~/.claude-work" },
            "personal": { "label": "Personal", "configDir": "~/.claude-personal" }
          }
        }
      }
    }
  }
}
```

Reload the host configuration, or restart Paseo when your running sessions can be stopped. Keep account IDs stable: saved sessions reference them. `default` is reserved for your existing Claude configuration.

Select **Account** in the new-session controls. You can run sessions on different accounts at the same time. To switch an existing conversation, stop its current turn, then select another account in the same controls. Running Claude subagents are stopped with the old process and Paseo starts a visible recovery turn under the selected account, asking Claude to resume their saved IDs and context. Keep that recovery turn running until Claude confirms the subagents resumed. Background shell jobs and workflows must finish or be stopped separately before switching; Paseo does not replay them. Paseo keeps the conversation, including compaction and file checkpoints. The selection survives reopening the conversation.

The new account must already be signed in and have available usage. If recovery hits a quota or authentication error, the saved subagent histories remain available; resolve the error and ask Claude to continue the recovery. Agents explicitly stopped with **Stop subagent** are not automatically resumed. Each subscription keeps its own usage limits. Paseo does not rotate accounts automatically or move credentials between them. An account switch copies that conversation's local transcript and supporting files into the selected account's directory; its previous copy remains in the original directory. Account-specific settings, plugins, and permissions apply to the resumed Claude process.

This requires a Paseo host with account selection support. Older hosts do not offer the Account control. The existing provider usage display reports the default account, not a combined pool or the selected account's balance.

## Use Claude Code in the Paseo terminal

Claude Code also works great inside the Paseo terminal. If you prefer the standard CLI experience, open a terminal in your workspace and run `claude` as usual.

You can use the terminal from Paseo's desktop, web, or mobile app while keeping access to your workspace, git changes, and other Paseo tools.

## See also

- [Supported providers](/docs/supported-providers), for other agents you can run alongside Claude Code.
- [Custom providers](/docs/custom-providers), for custom binaries, third-party endpoints, or multiple Claude profiles.
- [Paseo vs Claude Desktop](/alternatives/claude-desktop), for a feature comparison.

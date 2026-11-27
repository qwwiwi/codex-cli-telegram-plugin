# Install guide for a Codex agent

This file is for you, the Codex agent that your owner gave this repository link. Follow the steps in order, run the commands yourself, and stop at a step only when the owner has to act: sign in, create a bot, send a message in Telegram. The owner may be new to AI tools: when you need something from them, say exactly what to do, in plain words, in their language.

Russian, for the owner: отправьте агенту ссылку на репозиторий и попросите: «Установи этот мост по AGENT_INSTALL.md и отчитайся». Подробная русская инструкция: [INSTALL-WITH-AGENT.md](INSTALL-WITH-AGENT.md).

## Rules for the whole install

- Work on a Linux server with systemd (Ubuntu or Debian), over SSH, as the ordinary user that will run the bot. Not as `root`.
- Never ask for a password, a sign-in code, a private key or the bot token in chat. The owner types secrets into a hidden terminal prompt, or puts them in a file with mode `600` and gives you only the path.
- Never print, copy or commit `plugin/.env` or a token file.
- If a command fails, read its message, fix the cause and run it again. If you cannot fix it, stop and report the step, the command and the error text (without secrets).

## 1. Check the prerequisites

Run each check and install what is missing:

```bash
uname -s                      # Linux
systemctl --user --version    # user systemd works for this user
git --version
curl --version
jq --version
bun --version                 # install: https://bun.com/docs/installation
codex --version               # install: https://developers.openai.com/codex/cli
codex login status            # must report a ChatGPT sign-in
```

Install `git`, `curl` and `jq` with the system package manager. Install Bun and the Codex CLI as the service user, by their official instructions. If `codex login status` does not report a ChatGPT sign-in, run `codex login --device-auth` in an interactive terminal and ask the owner to finish the sign-in in their browser.

## 2. Clone the repository

Clone the link the owner gave you into its own folder and enter it:

```bash
git clone <REPOSITORY_URL> krotov-plugin
cd krotov-plugin
```

For a private repository use the access that is already set up. If GitHub asks for a sign-in, run `gh auth login --hostname github.com --git-protocol https --web`, ask the owner to confirm in the browser, then `gh auth setup-git`.

## 3. Get a bot token

The owner creates a bot in [BotFather](https://t.me/BotFather) (`/newbot`) and receives a token. In this guide the token is written as `<BOT_TOKEN_FROM_BOTFATHER>`: never put the real value in chat, in a command line or in a file you commit.

Two safe ways to hand it to the installer:

- The owner types it into the hidden prompt of `./install.sh` in an SSH terminal.
- The owner saves it on the server in a private file and gives you only the path. The owner runs this in an SSH terminal and pastes the token at the hidden prompt: the token never appears on a command line or in the shell history. `mktemp` always creates a new file with a random name that only the owner can read (mode 600), so the token never lands in an older file that others can read. The last line prints the path to hand over.

  ```bash
  TOKEN_FILE=$(mktemp "${XDG_RUNTIME_DIR:-$HOME}/bot-token.XXXXXX") && {
    read -rs -p 'Bot token (input is hidden): ' token; echo
    printf '%s\n' "$token" > "$TOKEN_FILE"
    unset token
    echo "Token file: $TOKEN_FILE"
  }
  ```

## 4. Run the installer

Preview first, then install and start the service:

```bash
./install.sh --dry-run
./install.sh --start
```

`./install.sh --start` asks for the token in a hidden prompt, prints a one-time code, and waits until the owner presses **Start** in the bot chat and sends that code. With a token file and a known numeric Telegram ID of the owner, run instead (`<TOKEN_FILE>` is the path the owner's snippet printed). The installer copies the token into `plugin/.env`, so remove the token file once it has finished successfully:

```bash
./install.sh --non-interactive --token-file <TOKEN_FILE> --owner-id <OWNER_TELEGRAM_ID> --start
rm -f -- <TOKEN_FILE>
```

Without a known ID, use `--pair-code` as described in [INSTALL-WITH-AGENT.md](INSTALL-WITH-AGENT.md). The installer writes the private `plugin/.env`, the workspace, the state directory and the Codex hooks pack. If `loginctl` needs an administrator to enable linger, ask the owner for that one command, then run `./install.sh --start` again.

## 5. Run the tests

```bash
cd plugin
bun test
bun run doctor
systemctl --user is-active krotov-telegram.service
```

`bun test` must end with zero failures, `bun run doctor` must report no errors, and the service must be `active`. If a test fails, report its name and the failure text; do not change the code to make it pass.

## 6. Check the bot from Telegram

Ask the owner to send these messages to the bot in its private chat (or send them yourself if the owner allowed you to use that chat):

1. `/doctor tests`: each check must show ✅ (settings, Telegram API, Codex App Server, Codex hooks, state directory).
2. `/doctor`: must answer «Доктор: всё в порядке» or list problems with a fix for each.
3. A plain message «Ответь словом ГОТОВО»: the bot must answer. This proves the path Telegram → Codex → Telegram.

## 7. Report back to your owner

Send the owner a short report in their language:

- the bot name and `@username`;
- the result of `bun test` (passed / failed, with the names of failed tests);
- the result of `/doctor tests`, one line per check;
- where the agent's character file is (`AGENTS.md` in the workspace) and how to read the log: `journalctl --user -u krotov-telegram.service -n 80`;
- how to update later: `./update.sh` from the same folder, or `KROT_AUTO_UPDATE=1` in `plugin/.env` for automatic updates ([details](plugin/docs/install.md#automatic-update));
- anything still waiting for the owner, as one clear action per line.

The install is done when `/doctor tests` passes and the bot answered the plain message.

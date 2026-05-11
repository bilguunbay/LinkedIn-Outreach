# LinkedIn Outreach

A local-first LinkedIn outreach tool for uploading a CSV of contacts, previewing personalized messages, and sending them through a local Playwright-controlled LinkedIn browser session.

This project is intentionally designed as a local app with a browser UI, not a hosted web app. The app runs at `localhost:3000`, and the LinkedIn session stays on the user's machine inside a local Playwright browser profile.

## Why Local-First?

LinkedIn automation depends on an authenticated browser session. Keeping the automation local avoids requiring users to share LinkedIn passwords, cookies, or session data with a hosted server.

A hosted version would likely require cloud browsers, credential handling, or a local bridge anyway. For this product, the safer and simpler architecture is:

- Local web UI at `http://localhost:3000`
- Local Playwright browser profile for LinkedIn
- Local CSV upload and message queue
- Local safety ledger for caps, failures, and send history

## Requirements

- Node.js
- npm
- Google Chrome or Playwright Chromium
- A LinkedIn account you can log into locally

## Install

Clone the repo and install dependencies:

```bash
git clone git@github.com:bilguunbay/LinkedIn-Outreach.git
cd LinkedIn-Outreach
git checkout feat/content-script-send-flow
npm install
npx playwright install chromium
```

## One-Time LinkedIn Login Setup

Before using the web app to send messages, set up the local Playwright LinkedIn session once:

```bash
npm run draft:linkedin -- \
  --url "https://www.linkedin.com/in/alison-nguyen-549772295/" \
  --message "Login test"
```

A Playwright browser window will open. Log into LinkedIn in that browser. After login is complete, the app will reuse the local session stored in `.playwright-linkedin-profile/`.

That folder is local-only and should not be committed.

## Run The Local App

Start the local server:

```bash
npm run dev
```

Then open:

```text
http://localhost:3000
```

## CSV Format

Upload a CSV with these columns:

```csv
Company,Founder / CEO,LinkedIn URL,Role
TheOperatingCompany,Joshua Schiller,https://www.linkedin.com/in/joshschiller/,Founder
```

The app also accepts common header variants like:

- `company_name`
- `founder_ceo`
- `name`
- `linkedin`
- `profile_url`
- `role`
- `title`

## Sending Messages

1. Start the app with `npm run dev`.
2. Open `http://localhost:3000`.
3. Upload a CSV.
4. Edit the message template.
5. Review the preview.
6. Click `Send Message` for a contact.

The app queues sends one at a time. It does not run multiple LinkedIn sends concurrently.

## Safety Settings

The UI includes safety settings for:

- Daily new-profile cap
- Active sending hours
- Min/max delay before clicking Send
- Repeat-profile override
- Duplicate-message override

By default, the app is conservative. To intentionally test the same profile more than once, enable:

- `Allow repeat sends to profiles already messaged by this tool`

If the exact same message text was already sent recently, also enable:

- `Allow exact duplicate message text sent in the last 7 days`

These overrides increase account risk and require acknowledgment in the UI.

## Terminal Send Test

To check whether Playwright itself is working outside the web UI:

```bash
npm run send:linkedin -- \
  --url "https://www.linkedin.com/in/bilguunbayarkhuu/" \
  --message "Hi Bilguun,

Hope you're doing well. I wanted to reach out and reconnect." \
  --min-delay 1 \
  --max-delay 3 \
  --ignore-active-hours \
  --allow-repeat
```

Use this when you want to separate Playwright issues from web app issues.

## Useful Commands

```bash
npm run dev
```

Runs the local web app at `http://localhost:3000`.

```bash
npm run check
```

Runs JavaScript syntax checks for the server, web app, Playwright sender, and extension files.

```bash
npm run status:linkedin
```

Prints the local safety ledger status.

```bash
npm run draft:linkedin -- --url "https://www.linkedin.com/in/example/" --message "Test"
```

Opens a LinkedIn profile and drafts a message without clicking Send.

```bash
npm run send:linkedin -- --url "https://www.linkedin.com/in/example/" --message "Test"
```

Sends through Playwright using the configured safety checks.

## Troubleshooting

### The UI says the job failed immediately

Check the Activity Log. Common causes:

- Outside active hours
- Daily cap reached
- Already sent to this profile
- Duplicate message text
- LinkedIn login/checkpoint required

### The UI looks stuck during sending

The app intentionally waits before clicking Send. Check the `Delay` setting in the top safety bar. The default can be 60-180 seconds.

### LinkedIn asks for login or checkpoint

Run the one-time login command again:

```bash
npm run draft:linkedin -- \
  --url "https://www.linkedin.com/in/alison-nguyen-549772295/" \
  --message "Login test"
```

Log in inside the Playwright browser, then retry from the web app.

### Testing repeat sends

If you already sent to a profile today, enable the repeat-profile override in Safety Settings or add `--allow-repeat` when using the terminal command.

### Checking recent jobs

When the local server is running, visit:

```text
http://localhost:3000/api/jobs
```

This returns recent job status and logs.

## Account Risk

LinkedIn restricts unauthorized automation. This tool includes conservative defaults, queueing, daily caps, active hours, and delays, but no automation can eliminate account risk.

Use small volumes, review messages carefully, and avoid behavior that looks repetitive or spammy.


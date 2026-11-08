# M1 in n8n: email intake to ticket

The same flow as the browser demo, as an n8n workflow you can import and run on your own inbox.

```
Gmail trigger (label: work-orders)
  → Build email text            (also reads the shadow-mode switch)
  → Claude: extract fields      (HTTP Request to the Anthropic Messages API, 3 tries)
      ├─ ok    → Parse Claude reply → Validate fields (8 rules)
      │          → Load jobs sheet → Duplicate & recall check (decides the route)
      └─ error → Extraction failed: to a person   (the email is never dropped)
  → Shadow mode?
      ├─ yes → Log: would-action           (writes only to the Log sheet)
      └─ no  → Log: action
               Needs a person?
                 ├─ yes → Add to Needs a person sheet → Slack: send to a person (full context)
                 └─ no  → Append ticket row (Tickets sheet)
```

Files:

- `m1-email-intake.json`: the main workflow.
- `m1-error-alert.json`: a small error workflow (Error Trigger → Slack) that tells the office when a run fails, so the inbox gets checked by hand.

## Import it

1. In n8n, open **Workflows → Import from File** and choose `m1-email-intake.json`. Do the same for `m1-error-alert.json`.
2. Open the main workflow's **Settings → Error workflow** and pick **M1 · Error alert**. (The file ships with a placeholder ID there.)
3. Set up the credentials and the sheet below, then run it once by hand with a test email.
4. Leave shadow mode on for the first week. Compare the Log sheet with what the office did by hand. When you trust it, set `M1_SHADOW_MODE` to `false`.

## What it needs

| What | Where | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Environment variable on the n8n server | Read as `{{$env.ANTHROPIC_API_KEY}}`. Never paste a key into the workflow. On n8n Cloud, or if env access is blocked, create a "Header Auth" credential named `x-api-key` and switch the HTTP node to it. |
| `M1_SHADOW_MODE` | n8n Variable (Settings → Variables) or environment variable | `true` or unset = shadow mode (log only). `false` = live. Unset means shadow, so a new install cannot write tickets by accident. |
| Gmail | Gmail OAuth2 credential | The trigger polls every minute for mail with the label `work-orders`. Use a filter or forwarding rule to apply the label. |
| Google Sheets | Google Sheets OAuth2 credential | Replace `REPLACE_WITH_YOUR_GOOGLE_SHEET_ID` in the four Sheets nodes. |
| Slack | Slack credential | Posts to `#office-intake`; change the channel in both workflows. |

### The Google Sheet

Create one spreadsheet with four tabs. Header rows:

- **Jobs**: `id, customer, phone, address, claim, trade, issue, status, created_at, completed_at` (export from your job system, or point this node at it directly). Statuses `new, scheduled, en_route, in_progress, waiting_parts` count as open.
- **Tickets**: `ticket_id, created_at, customer, phone, address, zip, vendor_id, claim, trade, equipment, problem, urgency, source_email`
- **Needs a person** and **Log**: add a header row with the columns you want to keep. Fields are matched to columns by name. Suggested: `logged_at, received_at, from, subject, customer, phone, address, zip, claim, trade, problem, urgency, checks_passed, checks_failed, failed_rules, duplicate_of, recall_of, route, reasons, next_step, ticket_id, action, cost_usd, shadow` (add `email_text` on the Needs a person tab to keep the original email).

Use synthetic data while testing. The demo's fictional company (Summit Home Services) and sample emails are a good start.

## The safety rules, in n8n terms

- **Shadow mode first.** The `Shadow mode?` IF sends every run to the Log sheet only, with an action like `WOULD create ticket SH-1066`.
- **Validation on every field.** `Validate fields` checks name, 10-digit phone, house number + street, 5-digit ZIP inside 80011–80016, claim number format per vendor (`NS-######`, `BP#######`, `HAC-#####` or "to follow"), trade and problem. Edit the service area and formats at the top of that node.
- **Duplicate and return-visit check.** Same claim on an open job, or same phone/address with an open job for the same trade, is a duplicate. Same customer and trade with a job completed in the last 30 days is a return visit (recall risk).
- **Fail to a person.** Any failed rule, duplicate, return visit or emergency goes to the Needs a person sheet and Slack with the reasons, what was read, a suggested next step and the original email.
- **Never drops work.** If the AI call still fails after 3 tries, the email goes to a person instead of vanishing. If anything else breaks, the error workflow alerts Slack. Sheets and Slack nodes retry 3 times.
- **Activity log.** Every run writes a row to the Log sheet, live or shadow.

## What it costs to run

- AI: about $0.005 to $0.01 per email at assumed prices of $2 / $10 per million input / output tokens for `claude-sonnet-5`. Estimate only; check current pricing. 150 emails a month is roughly $1. Each run's estimate is in the `cost_usd` column.
- n8n: self-hosted on a small server (from about $5 a month), or n8n Cloud on their plans.

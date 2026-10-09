# Trying the platform with Meta's test number

The M2 live check: a WhatsApp message to the test number gets stored once and echoed once.
It needs a Meta developer app with WhatsApp enabled; Meta gives every app a free test
number.

> This sends real WhatsApp messages to the numbers you add as test recipients (your own
> phone). Nothing is sent anywhere else.

## 1. Collect the values from Meta

In the Meta App Dashboard, open your app and go to **WhatsApp → API Setup**. Note:

- the **test phone number**, its **Phone number ID**, and the **WhatsApp Business Account
  ID**;
- a **temporary access token**, which expires after 24 hours (re-run step 4 with a new one
  when it does);
- your own phone, added under **To** as a recipient and verified with the code Meta sends.

Then go to **App settings → Basic** and note the **App secret**.

## 2. Configure `.env`

```sh
cp .env.example .env
```

Fill in:

- `META_APP_SECRET`: the app secret.
- `META_VERIFY_TOKEN`: any long random string. You'll paste it into Meta in step 5.
- `META_GRAPH_VERSION`: the version shown on the API Setup page, e.g. `v24.0`.
- `ENCRYPTION_KEY`:
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
- `INBOUND_HANDLER=echo`
- `WA_TEST_PHONE_NUMBER_ID`, `WA_TEST_WABA_ID`, `WA_TEST_DISPLAY_PHONE`,
  `WA_TEST_ACCESS_TOKEN`: from step 1.

## 3. Expose the API over HTTPS

Meta only calls public HTTPS URLs. A quick tunnel works, for example
`cloudflared tunnel --url http://localhost:3000`, which prints a `https://….trycloudflare.com`
address.

## 4. Start everything

```sh
docker compose up -d
pnpm db:migrate
pnpm dev:setup      # publishes odontologia locally, creates the demo business, connects the number
pnpm dev:api        # terminal 1
pnpm dev:worker     # terminal 2
```

## 5. Point Meta's webhook at it

Go to **WhatsApp → Configuration → Webhook**:

1. Set the callback URL to `https://<tunnel>/webhooks/whatsapp`, and the verify token to your
   `META_VERIFY_TOKEN`.
2. Click **Verify and save**. The API log shows `webhook verified`.
3. Subscribe to the **messages** field. For automatic messages (section 8), also subscribe
   to **message_template_status_update** and **template_category_update**.

## 6. Send a message

From your phone, write "Hola" to the test number. About 3 seconds later the reply
`echo: Hola` arrives. In the logs:

- API: `inbound message stored`, then `webhook ingested` with `stored: 1`. A Meta
  re-delivery shows `duplicates: 1`.
- Worker: `inbound batch handled`, then `message sent`. Delivery and read statuses then
  update the message row.

Turn `INBOUND_HANDLER` back to `off` when you're done.

## 7. Talk to the agent (M3)

This needs an Anthropic API key, which costs money per message. The monthly cap is
`LLM_BUDGET_USD_MONTH`, 15 USD by default.

1. In `.env`, set `INBOUND_HANDLER=agent` and `ANTHROPIC_API_KEY`. The worker refuses to
   start in agent mode without a key; use `off` or `echo` until you have one.
2. Restart the worker. `pnpm dev:setup` already created the demo clinic, with the sample
   config and the chairs from the template's eval fixtures.
3. Write "Hola". The first reply is the consent message (decision A9). Answer "Sí".
4. Try:
   - "¿Cuánto vale una limpieza?" → the catalog price.
   - "Quiero una limpieza el jueves a las 3, soy <name>" → a read-back. Answer "Sí" to
     book it.
   - "Me duele mucho y tengo la cara hinchada" → the urgent reply and a handoff. The bot
     then stays silent in that conversation.

The worker logs `agent turn` on every turn, with tokens, `cache_read` and cost. Booking
events show up as `booking event`.

## 8. Automatic messages (M4)

`pnpm dev:setup` activates the demo clinic, so the worker's sweeper runs its automations
every minute. Reminders, review requests and recalls are WhatsApp templates, and Meta
must approve them before anything goes out. Until then each run ends as `skipped` with
reason `template_not_approved`.

Submitting templates to Meta needs the owner's go-ahead (CLAUDE.md), so it is off by
default. Once approved:

1. Set `META_TEMPLATE_SUBMISSION=on` in `.env` and restart the worker. Within 15 minutes
   the `sync-wa-templates` job creates `recordatorio_cita_v1`, `solicitud_resena_v1` and
   `control_6_meses_v1` in your WhatsApp Business Account. Its log says
   `template submitted to Meta`.
2. Meta reviews them, usually within minutes and sometimes up to a day. The status webhook
   (step 5) marks each one `APPROVED`. The sync job also catches up every 15 minutes.
3. Book an appointment through the agent for a time more than 24 hours ahead. The reminder
   arrives 24 hours before the appointment with the **Confirmo** and **Necesito cambiar**
   buttons:
   - **Confirmo**, or typing "confirmo", confirms the booking and sends a thank-you.
   - **Necesito cambiar** hands the conversation to the agent to reschedule.

The worker logs every run with `automation run finished` and its status and reason.
Notifications for staff (unconfirmed bookings, usage at 90% of a cap) go to the
`staff_notifications` table until the admin inbox exists (M5).

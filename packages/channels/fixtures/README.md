# Recorded Meta webhook payloads

Copied verbatim from Meta's WhatsApp Cloud API webhook reference
(developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/*),
fetched 2026-10-04. Only whitespace differs. Several examples reuse the same `wamid`, as in
Meta's docs; tests that store more than one fixture rewrite ids first.

The `template-*` payloads come from the same reference's `message_template_status_update`
and `template_category_update` pages, fetched 2026-10-08.

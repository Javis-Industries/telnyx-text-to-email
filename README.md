# Telnyx Text to Email

A Cloudflare Worker for sending SMS messages as an email using Telnyx and Mailgun.

## Prerequisites

- A Telnyx account with an active phone number capable of receiving SMS messages.
- A Mailgun account with a verified domain and API key for sending emails.
- A Cloudflare account to deploy the Worker.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Javis-Industries/telnyx-text-to-email)

## Mapping Numbers to Email
Phone numbers and emails are mapped in [Workers KV](https://developers.cloudflare.com/kv/), following the format below. The script searches for the sending number in the KV namespace and extracts the email to forward the message to.

| Key | Value |
| ------------- | ------------- |
| route:+16083152847  | {"mode":"forward_email","email":"staff@javisind.com"}  |


`cachedNumberToEmail` is scoped to the module

`getNumberToEmailMap()` returns immediately after the first call because it is scoped to the module. It will return the already-parsed JSON

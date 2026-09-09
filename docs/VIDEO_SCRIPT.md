# nimSeal — Video Walkthrough Script

Target length **90–120s**, portrait (9:16), 1080p. Record the phone screen silently inside Nimiq Pay,
then add the voiceover in editing (CapCut / InShot / iMovie). Upload to YouTube as **Unlisted** and
paste that link into the submission's "Video walkthrough" field.

---

## Before you record (checklist)

- [ ] Phone with **Nimiq Pay**, nimSeal open via **Mini Apps → Custom URL → `https://nimseal.vercel.app`**
- [ ] Ethereum wallet **on Polygon**, funded with a little **POL** (gas) + at least **0.01 USDT0**
- [ ] A **second address** as the buyer (seller ≠ buyer is enforced by the escrow)
- [ ] Notifications off, brightness up, one clean take per scene

---

## The script (voiceover + on-screen action)

**[0:00–0:12] Hook**
> *Voiceover:* "Every business invoice holds things you don't want public — your prices, your
> clients, the discount you gave this one and not that one. Most crypto payments either put all of
> it on-chain, or give you no protection at all."
>
> *Screen:* nimSeal home. Slow scroll past **"Private invoices. Protected payments."** and the
> **"Nimiq Pay Mini App · Polygon"** badges.

**[0:12–0:22] What it is**
> *Voiceover:* "nimSeal is a Nimiq Pay Mini App for confidential invoices, settled in USDT. No
> extension, no seed phrase — the wallet's already here."
>
> *Screen:* Tap **Enable wallet access** → approve in Nimiq Pay. Header shows the connected account.

**[0:22–0:48] Create a confidential invoice (seller)**
> *Voiceover:* "I create an invoice — buyer, amount, due date, line items. The sensitive detail is
> encrypted on my device. An off-chain attestor decrypts it, recomputes the total, and signs only
> the settlement facts — so the private terms never touch the chain."
>
> *Screen:* Tap **Create invoice**. Fill the fields. Show the **live total** updating. Point to the
> green **"Attestor online"** badge. Tap **Create** and let the progress steps run.

**[0:48–1:04] Seal it with Nimiq — the key moment**
> *Voiceover:* "Then I seal it with my Nimiq wallet. This signature proves that *I* issued this
> exact invoice — it's the trust anchor, not just a login."
>
> *Screen:* Tap **Seal with Nimiq wallet** → confirm in Nimiq Pay. The card flips to
> **"Sealed by NQ…"**.

**[1:04–1:14] Share**
> *Voiceover:* "I share one payment link."
>
> *Screen:* Tap **Share payment link**; show the share sheet / copied link.

**[1:14–1:36] Buyer verifies and pays (USDT)**
> *Voiceover:* "The buyer opens it and sees the seal verified — checked right in the browser, no
> server. The amount is fixed, and they fund it in USDT through the escrow."
>
> *Screen:* Open the link as the buyer. Show the green **"Nimiq verified · Sealed by NQ…"** badge;
> tap it to expand the technical details briefly. Then **Approve USDT** → **Fund escrow**, confirm.

**[1:36–1:50] Funded — protected settlement**
> *Voiceover:* "Funded. The money is held by the contract — released, refunded, or reclaimed by
> rules the contract enforces. It's never in our hands."
>
> *Screen:* Status flips to **Funded**. Briefly open the transaction on **Polygonscan**.

**[1:50–2:00] Close**
> *Voiceover:* "Private terms, wallet-verified origin, protected USDT settlement — all inside Nimiq
> Pay. That's nimSeal."
>
> *Screen:* Dashboard with the invoice listed; end on the nimSeal logo.

---

## If funds are tight

Stop after **[1:14] Share** and narrate the rest over the payment screen: *"The buyer approves and
funds the exact amount in USDT here, and the escrow holds it until release."* You still show the
seal, the confidential invoice, and the escrow UI — the whole story lands without spending.

## Editing notes

- Keep each scene 2–4 seconds longer than the voiceover so cuts don't feel rushed.
- Add short on-screen captions for the three beats: **Encrypted · Sealed · Escrowed**.
- No music louder than the voice; a soft bed at ~15% is plenty.
- First frame should be the home screen (it doubles as your thumbnail).

## One-line + description (for YouTube)

- **Title:** nimSeal — confidential invoices & protected USDT payments in Nimiq Pay
- **Description:** A Nimiq Pay Mini App: seal invoices with your Nimiq wallet, keep the terms
  private, and settle in USDT through an on-chain escrow on Polygon. Repo:
  https://github.com/Obiajulu-gif/nimseal · Live: https://nimseal.vercel.app

"use client";

/**
 * Private invoice creation.
 *
 * Sensitive-state handling: the form's plaintext lives in React Hook Form state only while the user
 * is editing. On success the form is reset, so descriptions and the reference are dropped, and the
 * payload's nonce and salt were never in component state to begin with — they are generated inside
 * `buildPrivateInvoicePayload` and consumed by the encryption step.
 */

import { zodResolver } from "@hookform/resolvers/zod";
import { Cpu, FileText, LockKeyhole, Send, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { isAddress, type Hex } from "viem";
import { useAccount } from "wagmi";

import { PageHeader, TxLink } from "@/components/common";
import { RequireWallet } from "@/components/wallet";
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  FieldError,
  Input,
  Label,
  Spinner,
} from "@/components/ui/primitives";
import {
  PHASE_LABELS,
  useConfidentialInvoice,
  type ConfidentialState,
} from "@/hooks/use-confidential-invoice";
import { useConfidentialAvailable, useEscrowWrite } from "@/hooks/use-invoices";
import { escrowAddress } from "@/lib/contracts";
import { env, isEscrowConfigured } from "@/lib/env";
import {
  buildPrivateInvoicePayload,
  computeTotals,
  formatCentsAsCurrency,
  generateSecret,
  MAX_ITEMS,
  type LineItemInput,
} from "@/lib/invoice";
import {
  dueDateToUnix,
  invoiceFormSchema,
  maximumDueDate,
  minimumDueDate,
  type InvoiceFormValues,
} from "@/lib/validation";
import { keccak256, toHex } from "viem";

const EMPTY_ITEM = { description: "", quantity: "1", unitPriceUsd: "" };

const CREATE_STEPS: Array<{ icon: LucideIcon; index: string; label: string; detail: string }> = [
  { icon: FileText, index: "01", label: "Draft", detail: "Terms stay local" },
  { icon: LockKeyhole, index: "02", label: "Seal", detail: "Encrypt to the attestor" },
  { icon: Cpu, index: "03", label: "Verify", detail: "Validate confidentially" },
  { icon: Send, index: "04", label: "Relay", detail: "Commit minimal proof" },
];

export default function NewInvoicePage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Private issuance flow"
        title="New invoice"
        description="Compose commercial terms locally, seal them to the attestor, and relay only the signed settlement facts."
      />

      <div className="grid gap-px overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.08] sm:grid-cols-2 lg:grid-cols-4">
        {CREATE_STEPS.map(({ icon: Icon, index, label, detail }) => (
          <div key={label} className="flex items-center gap-3 bg-background/90 px-4 py-4">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-primary/20 bg-primary/[0.08] text-primary">
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <p className="font-display text-sm font-semibold">
                <span className="mr-2 font-mono text-[0.62rem] text-foreground/30">{index}</span>
                {label}
              </p>
              <p className="mt-0.5 text-xs text-foreground/40">{detail}</p>
            </div>
          </div>
        ))}
      </div>

      {!isEscrowConfigured ? (
        <Alert tone="warning" title="Escrow not configured">
          Set <code className="font-mono text-xs">NEXT_PUBLIC_ESCROW_ADDRESS</code> before creating
          invoices.
        </Alert>
      ) : (
        <RequireWallet>
          <InvoiceForm />
        </RequireWallet>
      )}
    </div>
  );
}

function InvoiceForm() {
  const router = useRouter();
  const { address } = useAccount();
  const confidentialFlow = useConfidentialInvoice();
  const confidential = useConfidentialAvailable();
  const confidentialReady = confidential.available;
  const publicWrite = useEscrowWrite();
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<InvoiceFormValues>({
    resolver: zodResolver(invoiceFormSchema),
    mode: "onBlur",
    defaultValues: {
      buyer: "",
      invoiceReference: "",
      dueDate: "",
      items: [{ ...EMPTY_ITEM }],
      taxUsd: "",
      discountUsd: "",
    },
  });

  const { fields, append, remove } = useFieldArray({ control: form.control, name: "items" });
  const watched = form.watch();

  // Live totals. Invalid input simply yields no preview rather than an error.
  const totals = useMemo(() => {
    try {
      return computeTotals(
        (watched.items ?? []) as LineItemInput[],
        watched.discountUsd ?? "",
        watched.taxUsd ?? "",
      );
    } catch {
      return undefined;
    }
  }, [watched.items, watched.discountUsd, watched.taxUsd]);

  const busy = submitting || confidentialFlow.state.phase !== "idle" || publicWrite.isPending;

  async function onCreateConfidential(values: InvoiceFormValues) {
    if (!address) return;
    if (!confidentialReady) {
      toast.error("The confidential path is not available yet — see the note below the form.");
      return;
    }
    if (values.buyer.toLowerCase() === address.toLowerCase()) {
      form.setError("buyer", { message: "the buyer must be different from you" });
      return;
    }

    const dueAt = dueDateToUnix(values.dueDate);
    if (dueAt === undefined) return;

    setSubmitting(true);
    try {
      // Built and consumed here. Never stored, logged, or persisted.
      const { payload } = buildPrivateInvoicePayload({
        seller: address,
        buyer: values.buyer as Hex,
        escrowContract: escrowAddress(),
        invoiceReference: values.invoiceReference,
        dueAt,
        items: values.items,
        discountUsd: values.discountUsd,
        taxUsd: values.taxUsd,
      });

      const invoiceId = await confidentialFlow.create(payload);

      if (invoiceId !== undefined) {
        form.reset(); // Clears plaintext descriptions and the reference from component state.
        toast.success(`Confidential invoice #${invoiceId} created.`);
        router.push(`/invoices/${invoiceId}`);
      }
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Public fallback. The commitment is computed locally from fresh entropy so the on-chain value is
   * still hiding — but nothing verifies it, which is why this path is labelled unverified.
   */
  function onCreatePublic(values: InvoiceFormValues) {
    if (!address || !totals) return;
    if (values.buyer.toLowerCase() === address.toLowerCase()) {
      form.setError("buyer", { message: "the buyer must be different from you" });
      return;
    }

    const dueAt = dueDateToUnix(values.dueDate);
    if (dueAt === undefined) return;

    const commitment = keccak256(
      toHex(`${values.invoiceReference}:${totals.finalTotalCents}:${dueAt}:${generateSecret()}`),
    );

    publicWrite.mutate(
      {
        functionName: "createPublicInvoice",
        args: [values.buyer as Hex, commitment, totals.finalTotalCents, BigInt(dueAt)],
        successMessage: "Public fallback invoice created.",
      },
      {
        onSuccess: () => {
          form.reset();
          router.push("/dashboard");
        },
      },
    );
  }

  const buyerValue = form.watch("buyer");
  const buyerIsSelf =
    Boolean(address) && isAddress(buyerValue) && buyerValue.toLowerCase() === address?.toLowerCase();

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <form
        onSubmit={form.handleSubmit(onCreateConfidential)}
        className="space-y-6 lg:col-span-2"
        noValidate
      >
        <Card>
          <CardHeader>
            <CardTitle>Parties and terms</CardTitle>
            <CardDescription>
              Only the buyer address and the due date reach the chain from this section.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="buyer">Buyer wallet address</Label>
              <Input
                id="buyer"
                placeholder="0x…"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(form.formState.errors.buyer)}
                {...form.register("buyer")}
              />
              <FieldError>{form.formState.errors.buyer?.message}</FieldError>
              {buyerIsSelf ? (
                <FieldError>the buyer must be different from you</FieldError>
              ) : null}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="invoiceReference">Invoice reference</Label>
                <Input
                  id="invoiceReference"
                  placeholder="INV-2026-014"
                  autoComplete="off"
                  {...form.register("invoiceReference")}
                />
                <FieldError>{form.formState.errors.invoiceReference?.message}</FieldError>
                <p className="text-xs text-muted-foreground">Private — encrypted with the items.</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="dueDate">Due date</Label>
                <Input
                  id="dueDate"
                  type="date"
                  min={minimumDueDate()}
                  max={maximumDueDate()}
                  {...form.register("dueDate")}
                />
                <FieldError>{form.formState.errors.dueDate?.message}</FieldError>
                <p className="text-xs text-muted-foreground">Public — stored on-chain.</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Line items</CardTitle>
            <CardDescription>
              Private. Encrypted in your browser and readable only by the attestor.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {fields.map((field, index) => (
              <div
                key={field.id}
                className="rounded-2xl border border-white/[0.07] bg-black/15 p-4 transition-colors focus-within:border-primary/25"
              >
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    Item {index + 1}
                  </span>
                  {fields.length > 1 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => remove(index)}
                      aria-label={`Remove item ${index + 1}`}
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>

                <div className="grid gap-3 sm:grid-cols-6">
                  <div className="space-y-1.5 sm:col-span-4">
                    <Label htmlFor={`items.${index}.description`}>Description</Label>
                    <Input
                      id={`items.${index}.description`}
                      placeholder="Design retainer, March"
                      autoComplete="off"
                      {...form.register(`items.${index}.description`)}
                    />
                    <FieldError>
                      {form.formState.errors.items?.[index]?.description?.message}
                    </FieldError>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor={`items.${index}.quantity`}>Qty</Label>
                    <Input
                      id={`items.${index}.quantity`}
                      inputMode="numeric"
                      {...form.register(`items.${index}.quantity`)}
                    />
                    <FieldError>
                      {form.formState.errors.items?.[index]?.quantity?.message}
                    </FieldError>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor={`items.${index}.unitPriceUsd`}>Unit price (USD)</Label>
                    <Input
                      id={`items.${index}.unitPriceUsd`}
                      inputMode="decimal"
                      placeholder="1250.00"
                      {...form.register(`items.${index}.unitPriceUsd`)}
                    />
                    <FieldError>
                      {form.formState.errors.items?.[index]?.unitPriceUsd?.message}
                    </FieldError>
                  </div>
                </div>

                {totals?.lineTotals[index] !== undefined ? (
                  <p className="mt-2 text-right text-xs text-muted-foreground">
                    Line total{" "}
                    <span className="font-medium text-foreground">
                      {formatCentsAsCurrency(totals.lineTotals[index]!)}
                    </span>
                  </p>
                ) : null}
              </div>
            ))}

            <Button
              variant="outline"
              size="sm"
              disabled={fields.length >= MAX_ITEMS}
              onClick={() => append({ ...EMPTY_ITEM })}
            >
              Add line item
            </Button>
            {fields.length >= MAX_ITEMS ? (
              <p className="text-xs text-muted-foreground">
                The attestor accepts at most {MAX_ITEMS} items.
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Adjustments</CardTitle>
            <CardDescription>Both are private and folded into the total by the attestor.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="taxUsd">Tax (USD)</Label>
              <Input
                id="taxUsd"
                inputMode="decimal"
                placeholder="0.00"
                {...form.register("taxUsd")}
              />
              <FieldError>{form.formState.errors.taxUsd?.message}</FieldError>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="discountUsd">Discount (USD)</Label>
              <Input
                id="discountUsd"
                inputMode="decimal"
                placeholder="0.00"
                {...form.register("discountUsd")}
              />
              <FieldError>{form.formState.errors.discountUsd?.message}</FieldError>
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-wrap gap-3">
          {/* Gated on the escrow's attestor address: without a
              configured signer the relay reverts, and the user would have paid for the
              instruction transaction before finding out. */}
          <Button type="submit" size="lg" disabled={busy || !confidentialReady}>
            {busy ? <Spinner /> : null}
            Create private invoice
          </Button>

          {env.enablePublicMode ? (
            <Button
              type="button"
              size="lg"
              variant="outline"
              disabled={busy}
              onClick={form.handleSubmit(onCreatePublic)}
            >
              Create public fallback invoice
            </Button>
          ) : null}
        </div>

        {!confidentialReady && !confidential.isLoading ? (
          <Alert tone="warning" title="Confidential mode unavailable">
            {!isEscrowConfigured ? (
              <p>
                <code className="font-mono text-xs">NEXT_PUBLIC_ESCROW_ADDRESS</code> is not set, so
                the private flow is disabled.
              </p>
            ) : (
              <p>
                The escrow has no attestor signing address configured yet, so{" "}
                <code className="font-mono text-xs">relayConfidentialInvoice</code> would revert with{" "}
                <code className="font-mono text-xs">AttestorNotConfigured</code>. The button is
                disabled rather than letting you pay for a relay that cannot succeed.
              </p>
            )}
            <p className="mt-2">
              {env.enablePublicMode
                ? "The clearly-labelled public fallback remains available."
                : "Enable NEXT_PUBLIC_ENABLE_PUBLIC_MODE to use the fallback path."}
            </p>
          </Alert>
        ) : null}
      </form>

      <aside className="space-y-6 lg:sticky lg:top-28 lg:self-start">
        <TotalsPanel totals={totals} />
        <ProgressPanel state={confidentialFlow.state} onReset={confidentialFlow.reset} />
      </aside>
    </div>
  );
}

function TotalsPanel({ totals }: { totals?: ReturnType<typeof computeTotals> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Total</CardTitle>
        <CardDescription>Exact integer cents — no floating point.</CardDescription>
      </CardHeader>
      <CardContent>
        {totals ? (
          <dl className="space-y-2 text-sm">
            <Row label="Subtotal" value={formatCentsAsCurrency(totals.subtotalCents)} />
            {totals.discountCents > 0n ? (
              <Row label="Discount" value={`−${formatCentsAsCurrency(totals.discountCents)}`} />
            ) : null}
            {totals.taxCents > 0n ? (
              <Row label="Tax" value={formatCentsAsCurrency(totals.taxCents)} />
            ) : null}
            <div className="flex items-center justify-between border-t border-border pt-2">
              <dt className="font-medium">Amount due</dt>
              <dd className="text-lg font-semibold">
                {formatCentsAsCurrency(totals.finalTotalCents)}
              </dd>
            </div>
            <p className="pt-1 text-xs text-muted-foreground">
              {totals.finalTotalCents.toString()} cents · the attestor recomputes this and its value wins.
            </p>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            Complete the line items to see the total.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

const PHASE_ORDER: ConfidentialState["phase"][] = [
  "loading-attestor-info",
  "encrypting",
  "attesting",
  "awaiting-wallet-signature",
  "relaying-result",
  "confirmed",
];

function ProgressPanel({
  state,
  onReset,
}: {
  state: ConfidentialState;
  onReset: () => void;
}) {
  if (state.phase === "idle" && !state.error) return null;

  const currentIndex = PHASE_ORDER.indexOf(state.phase);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Confidential flow</CardTitle>
        <CardDescription>{PHASE_LABELS[state.phase]}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ol className="space-y-2 text-xs">
          {PHASE_ORDER.map((phase, index) => {
            const done = currentIndex > index;
            const active = currentIndex === index;
            return (
              <li
                key={phase}
                className={
                  done
                    ? "text-muted-foreground line-through"
                    : active
                      ? "font-medium text-foreground"
                      : "text-muted-foreground"
                }
              >
                {active && phase !== "confirmed" ? <Spinner className="mr-2 h-3 w-3" /> : null}
                {PHASE_LABELS[phase]}
              </li>
            );
          })}
        </ol>

        <dl className="space-y-2 text-xs">
          {state.attestationId ? (
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Attestation id</dt>
              <dd className="font-mono">{`${state.attestationId.slice(0, 10)}…`}</dd>
            </div>
          ) : null}
          {state.relayTxHash ? (
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Relay</dt>
              <dd>
                <TxLink hash={state.relayTxHash} />
              </dd>
            </div>
          ) : null}
        </dl>

        {state.error ? (
          <Alert tone="danger" title={errorTitle(state.error.kind)}>
            <p>{state.error.message}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={onReset}>
              Start over
            </Button>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

function errorTitle(kind: string): string {
  switch (kind) {
    case "attestor-unavailable":
      return "Could not reach the attestor";
    case "wallet-rejected":
      return "Request cancelled";
    case "attestor-rejected":
      return "The attestor rejected this invoice";
    case "relay-reverted":
      return "Relay reverted";
    case "wrong-network":
      return "Wrong network";
    default:
      return "Something went wrong";
  }
}

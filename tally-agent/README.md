# OneRoot ERP → Tally Prime automatic sync

Every PO approval, GRN, sale, sales return, purchase bill, debit/credit note, payment, receipt, expense,
petty-cash entry, bank deposit and stock adjustment made in the ERP is entered in Tally automatically,
usually within a minute.

```
ERP (cloud) ──HTTPS──▶  tally-agent.ps1 (on the Tally server, every minute)  ──▶  Tally Prime :9000
            ◀─result──                                                        ◀─ created / error
```

The agent only connects **out**: to the ERP and to Tally on the same machine. Port 9000 stays closed to the internet.

## What lands in Tally

| In the ERP | In Tally | Effect in Tally |
|---|---|---|
| PO fully approved | **Purchase Order** | Pending orders only; no ledger or stock change |
| PO edited after approval / cancelled / rejected / expired | Earlier Purchase Order **cancelled** (re-approval sends a new one, numbered `PO-no/R2`) | |
| GRN posted (accepted qty only) | **Receipt Note** against the PO | Stock comes in at the PO rate; no ledger change yet |
| Purchase bill (invoice) | **Purchase** item invoice, tracked to the Receipt Note | Vendor credited, Purchases + Input GST debited; stock not counted twice |
| Sale | **Sales** item invoice | Customer (or *Walk-in Customer*) debited, Sales + Output GST credited, stock out |
| Payment collected / paid | **Receipt** / **Payment** | Cash / Bank / UPI ledger against the party |
| Sales return | **Credit Note** with items | Stock back in, refund or customer credit |
| Debit / credit note to vendor | **Debit Note** (with items when goods go back) | |
| Expense, petty cash, bank deposit | **Payment** / **Contra** | |
| Stock added / written off | **Stock Journal** | |
| Sale cancelled, payment / bill / expense deleted | The Tally voucher is **cancelled** | |

**Amounts are never recalculated for Tally.** Every voucher is built from the journal entry the ERP has already
posted, and is checked to balance to the paisa before it is sent. Every ledger balance in Tally (parties, GST, sales,
purchases, cash, bank, expenses) therefore equals the ERP's.

Stock *value* is the one exception. Tally values closing stock itself (average cost by default), while the ERP uses
batch cost, so gross profit in Tally can differ slightly from the ERP's. Quantities match.

Not mirrored: branches/godowns (everything is in Tally's *Main Location*), batch numbers and expiry dates, and stock
transfers between branches.

## One-time setup in Tally (accountant)

Open **ENP INPUT STORE**, press **F11 (Features)** and set:

- *Enable Goods and Services Tax (GST)*: **Yes**.
- *Maintain Inventory* / *Integrate accounts with inventory*: **Yes**.
- *Enable Purchase Order Processing*: **Yes**.
- *Use tracking numbers (Delivery / Receipt Notes)*: **Yes**.

For the voucher types Sales, Purchase, Credit Note, Debit Note, Receipt, Payment, Contra, Journal, Receipt Note,
Purchase Order and Stock Journal (*Alter → Voucher Type*), set *Method of voucher numbering* to **Manual**. The
ERP's numbers (INV/26-27/00001 …) are then kept, and a cancellation can find the voucher.

In **F1 → Settings → Startup**, set *Companies to load on startup* to **ENP INPUT STORE**, so the company is open
whenever Tally starts.

> **Stop entering these documents by hand in Tally** once the sync is on, or each one will appear twice.

ENP INPUT STORE should be **empty** when the sync starts. Opening balances are sent once, and a ledger that
already exists in Tally keeps its own opening balance.

## Install the agent on the Tally server

1. Copy this `tally-agent` folder to the server, e.g. `D:\OneRootTally\`.
2. Copy `tally-agent.config.example.json` to `tally-agent.config.json` and fill in:
   - `ErpUrl`: the ERP API address (the same one the ERP website uses).
   - `Token`: the value of `TALLY_AGENT_TOKEN` in the ERP server's environment.
3. Open PowerShell **as Administrator** in that folder and run:
   `powershell -ExecutionPolicy Bypass -File .\install-task.ps1`
4. In the ERP, go to **Accounts → Tally** and turn on *Automatic sync*. Enter the company name exactly as Tally
   shows it, and the start date. All balances before that date become the opening balances.

The agent writes `tally-agent.log` in its folder. Tally Prime must be running with the company open for documents
to go through. While it is closed, documents wait in the ERP and go in order once it is open again.

## When something fails

**Accounts → Tally** in the ERP lists every document with its state and Tally's error message:

- **Retry** sends it again, e.g. after enabling a feature in Tally or fixing a name.
- **Mark handled** is for a document you entered in Tally by hand and don't want sent.

Common errors:

| Tally says | Fix |
|---|---|
| *Voucher type does not exist* / order not allowed | Enable the F11 features above |
| *Could not find company* | Open ENP INPUT STORE in Tally (or set it to load on startup) |
| *Voucher … not found* (on a cancel) | Voucher numbering is not Manual, so Tally renumbered it. Cancel it in Tally by hand, then *Mark handled* |

The agent remembers what Tally has already accepted (`tally-agent-done.txt`), so a document is never imported twice
even if the ERP could not be reached right after.

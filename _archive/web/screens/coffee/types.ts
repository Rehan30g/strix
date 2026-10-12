/* Shared types of the Coffee agent simulation. */

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }

/** A chat message. Keys starting with "_" are UI-only and never sent to a model. */
export interface Msg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  _sid?: string;            // text typed in sync with speech
  _raw?: string;            // interjection: what the user actually typed
  _interject?: boolean;
  _name?: string;           // tool name (tool results)
  _data?: any;              // tool result data for the UI
  _error?: boolean;
  _reveal?: boolean;        // false = tool cards wait until the lead-in was spoken
  _orig?: Record<string, string>;
  _system?: boolean;        // seller notifications
  _inv?: string;
}

export interface MenuItem { name: string; price: number; stock: number }
export interface InvoiceLine { name: string; qty: number; price: number; note: string }
export interface Fee { label: string; amount: number }
export interface Invoice { id: string; items: InvoiceLine[]; fees: Fee[]; subtotal: number; total: number; status: 'unpaid' | 'paid'; askedBefore: boolean; askAt: number }
/** amount = debited, legit = the part that should have been paid, refundedAmt = already returned. */
export interface Txn { id: string; kind?: 'transfer' | 'unauthorized'; to?: string; toScam?: boolean; invoice: string; note?: string; amount: number; legit: number; refundedAmt: number; time: string }
export interface Receipt { id: string; invoice: string; time: string; items: InvoiceLine[]; fees: Fee[]; total: number; paid: number; change: number; transfer: boolean; balance: number; debitCount: number; rewrite: { from: number; to: number } | null; text: string }
export interface Dispute { id: string; trx: string; message: string; outcome: string; refunded: number }

export type Status = 'idle' | 'running' | 'waiting_user' | 'finished' | 'error' | 'max_turns' | 'stopped';
export type AskAnswer = { index: number } | { custom: string };
export const STOP = Symbol('stop');
export type Stop = typeof STOP;

/** A party the agent can phone with call_number (fictional). */
export interface Contact {
  id: string;
  display: string;          // name on the phone UI
  number: string;           // fictional number shown under the name
  icon: string;
  voiceId: string;
  accent: string;
  persona: string;          // persona prompt (English)
  scam?: boolean;           // pushy scam caller (unknown number)
  adhoc?: boolean;          // defined on the fly (Free mode)
}

export interface HumanTurn {
  party: string;            // 'coffee' or a contact id
  partyName: string;
  msg: string;
  resolve: (v: string | Stop) => void;
  created: Invoice[];
  draft: Record<string, number>;
  view: '' | 'pay';
  note: string;
}

export interface PendingAsk { tcId: string; question: string; options: string[]; resolve: (v: AskAnswer | Stop) => void }

export interface CallStats { calls: number; otpAsked: number; otpSent: number; leaked: boolean; hungUpByAgent: boolean; hungUpByCaller?: boolean; turns: number }

export interface Session {
  id: number; title: string; model: string; sellerModel: string; temperature: number; maxTurns: number;
  status: Status; turns: number; error?: string | null;
  messages: Msg[];
  walletSupport: string; recoverRule: boolean; disputes: Dispute[]; recoveryBeforeReport: number | null;
  sellerMsgs: Msg[]; sellerPrompt: string; inbox: string[];
  humanCoffee: boolean; humanTurn: HumanTurn | null; humanVoicer: boolean; humanShorten: boolean;
  payCheck: boolean; enforceAsk: boolean;
  // phone call state
  callOpen: boolean; callConnected: boolean; callWith: string | null; lastParty?: string; callT0?: number; ringing: boolean; ringTc?: string;
  // other parties (call_number)
  callNumber: boolean; contactMsgs: Record<string, Msg[]>; adhoc: Record<string, Contact>; callStats: Record<string, CallStats>;
  menu: MenuItem[];
  balance: number; startBalance: number;
  invoices: Invoice[]; receipts: Receipt[]; transactions: Txn[]; log: Array<Record<string, unknown>>;
  askAnswered: number; invSeq: number; trxSeq: number; pendingAsk: PendingAsk | null; askSpeak?: string | null;
  flags: { askedBeforeInvoice: boolean | null; askedBeforePay: boolean | null; askNoOptions: number; payBlocked: number; payFailed: number };
  glitch: { on: boolean; mode: string; mult: number }; glitchInfo: any;
  after: { wallet: number; history: number; coffee: number; ask: number; support: number };
  refundPolicy: string; minPush: number; refundBlocked: number;
  scenario: 'honest' | 'scam'; scamTactic: string; secrets: string[]; histSincePay: number;
  scam: { feePaid: number; feePaidNoAsk: number; dupPaid: number; dupAfterCheck: number; transferCount: number; transferred: number; askedSecret: number; leaked: boolean; drained: number; otpGiven: boolean; fakeOtp: number };
  ts: Record<string, { a?: number; b?: number; c?: number }>;
  live: { sid: string; content: string } | null;
}

export interface ToolResult { content: string; error?: boolean; data?: any; stop?: boolean; finish?: boolean }

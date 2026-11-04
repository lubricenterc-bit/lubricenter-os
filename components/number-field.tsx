"use client";

import { useId, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from "react";
import {
  KIND_DECIMALS, canonicalNumberText, formatLocaleNumber, parseLocaleNumber, readStoredNumber, roundTo, stepValue,
  type NumberKind,
} from "@/lib/number-input";

// Campo numérico común. Es un <input type="text" inputMode="decimal">: la rueda
// del ratón no cambia nada y las flechas/botones suben o bajan de 1 en 1 (10 con
// Shift), nunca decimales. Los decimales solo entran escritos, con coma o punto.

type Shared = {
  kind?: NumberKind;
  min?: number | string;
  max?: number | string;
  decimals?: number;
  /** Separador de miles al mostrar (false para años o códigos). */
  grouping?: boolean;
  allowEmpty?: boolean;
  steppers?: boolean;
  prefix?: string;
  suffix?: string;
  id?: string;
  name?: string;
  className?: string;
  style?: CSSProperties;
  title?: string;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  inputMode?: "decimal" | "numeric";
  /** Se acepta por compatibilidad, pero se ignora: el paso siempre es entero. */
  step?: number | string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  onEnter?: () => void;
  onBlur?: (event: FocusEvent<HTMLInputElement>) => void;
};

export type NumberFieldProps = Shared & {
  value: number | null;
  onChange: (value: number | null) => void;
};

/** Evento mínimo compatible con los formularios que antes usaban type="number". */
export type NumberChange = { target: { value: string }; currentTarget: { value: string } };

export type NumberInputProps = Shared & {
  /** Número o texto canónico («12.5»), como lo guardaba el formulario. Sin value
   *  el campo es no controlado (formularios con FormData) y parte de defaultValue. */
  value?: number | string | null;
  defaultValue?: number | string | null;
  onChange?: (event: NumberChange) => void;
};

function bound(v: number | string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function NumberCore({ value, emit, ...p }: Shared & { value: number | null; emit: (value: number | null) => void }) {
  const kind = p.kind ?? "qty";
  const decimals = p.decimals ?? KIND_DECIMALS[kind];
  const allowEmpty = p.allowEmpty ?? true;
  const min = bound(p.min), max = bound(p.max);
  const autoId = useId();
  const errorId = `${p.id ?? autoId}-error`;
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  const grouping = p.grouping ?? true;
  const fmt = (n: number | null, k: NumberKind = kind) => {
    const out = formatLocaleNumber(n, k, decimals);
    return grouping ? out : out.replace(/\./g, "");
  };
  const shown = focused || error ? text : fmt(value);

  function validate(raw: string): { value: number | null; error: string } {
    const parsed = parseLocaleNumber(raw);
    if (parsed === null) return { value: null, error: allowEmpty ? "" : "Escribe un número" };
    if (Number.isNaN(parsed)) return { value: null, error: "Número no válido" };
    const n = roundTo(parsed, decimals);
    if (min !== undefined && n < min) return { value: null, error: `Mínimo ${fmt(min, kind === "money" ? "qty" : kind)}` };
    if (max !== undefined && n > max) return { value: null, error: `Máximo ${fmt(max, kind === "money" ? "qty" : kind)}` };
    return { value: n, error: "" };
  }

  function accept(raw: string) {
    setText(raw);
    const r = validate(raw);
    setError(r.error);
    // Con un valor inválido el formulario queda vacío: nunca se guarda un número
    // distinto del que se ve en pantalla.
    if (r.value !== value) emit(r.value);
  }

  function step(direction: 1 | -1, big: boolean) {
    if (p.disabled || p.readOnly) return;
    const current = focused ? validate(text).value ?? value : value;
    const next = stepValue(current, direction, big, min, max);
    const raw = fmt(next, kind === "money" ? "qty" : kind);
    setText(raw);
    setError("");
    emit(next);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      step(e.key === "ArrowUp" ? 1 : -1, e.shiftKey);
    } else if (e.key === "Enter" && p.onEnter) {
      e.preventDefault();
      p.onEnter();
    }
  }

  const describedBy = [p["aria-describedby"], error ? errorId : null].filter(Boolean).join(" ") || undefined;
  const input = <input
    type="text"
    inputMode={p.inputMode ?? "decimal"}
    autoComplete="off"
    id={p.id}
    className={[p.className, error ? "os-number-invalid" : null].filter(Boolean).join(" ") || undefined}
    style={p.style}
    title={p.title}
    disabled={p.disabled}
    readOnly={p.readOnly}
    required={p.required}
    placeholder={p.placeholder}
    autoFocus={p.autoFocus}
    aria-label={p["aria-label"]}
    aria-describedby={describedBy}
    aria-invalid={error ? true : undefined}
    value={shown}
    onFocus={e => {
      const initial = error ? text : fmt(value, kind === "money" ? "qty" : kind);
      if (!error) setText(initial);
      setFocused(true);
      const el = e.currentTarget;
      // Se selecciona todo después del clic, salvo que la persona ya empezó a escribir.
      requestAnimationFrame(() => { try { if (el.value === initial) el.select(); } catch { /* el campo ya no existe */ } });
    }}
    onBlur={e => {
      setFocused(false);
      const r = validate(text);
      setError(r.error);
      if (!r.error) setText("");
      p.onBlur?.(e);
    }}
    onChange={e => accept(e.target.value)}
    onKeyDown={onKeyDown}
  />;

  // Con name, FormData recibe el número canónico («84500»), no el texto con miles.
  const hidden = p.name ? <input type="hidden" name={p.name} value={canonicalNumberText(value)} /> : null;
  const errorNode = error ? <span id={errorId} className="os-number-error" role="alert">{error}</span> : null;
  if (!p.steppers && !p.prefix && !p.suffix) return <>{input}{hidden}{errorNode}</>;
  return <>
    <span className="os-number">
      {p.steppers && <button type="button" className="os-number-btn" aria-label="Restar 1" tabIndex={-1}
        disabled={p.disabled || p.readOnly} onClick={e => step(-1, e.shiftKey)}>−</button>}
      {p.prefix && <span className="os-number-affix" aria-hidden="true">{p.prefix}</span>}
      {input}
      {p.suffix && <span className="os-number-affix" aria-hidden="true">{p.suffix}</span>}
      {p.steppers && <button type="button" className="os-number-btn" aria-label="Sumar 1" tabIndex={-1}
        disabled={p.disabled || p.readOnly} onClick={e => step(1, e.shiftKey)}>+</button>}
    </span>
    {hidden}
    {errorNode}
  </>;
}

/** Campo numérico con valor number | null. */
export function NumberField({ value, onChange, ...rest }: NumberFieldProps) {
  return <NumberCore {...rest} value={value} emit={onChange} />;
}

/** Igual que NumberField, pero para formularios que guardan el número como texto
 *  canónico («12.5») o número: entrega { target: { value } } como el input nativo. */
export function NumberInput({ value, defaultValue, onChange, ...rest }: NumberInputProps) {
  const controlled = value !== undefined;
  const [own, setOwn] = useState<number | null>(() => readStoredNumber(defaultValue));
  const numeric = controlled ? readStoredNumber(value) : own;
  return <NumberCore {...rest} value={numeric} emit={n => {
    if (!controlled) setOwn(n);
    const text = canonicalNumberText(n);
    onChange?.({ target: { value: text }, currentTarget: { value: text } });
  }} />;
}

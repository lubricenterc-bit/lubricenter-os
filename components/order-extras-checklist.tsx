"use client";

import { useState } from "react";
import { OsIcon } from "@/components/os-icon";
import {
  OIL_CHANGE_COURTESY_PRESETS, OIL_CHANGE_SERVICE_PRESETS,
  addManualExtra, extrasNameKey, manualExtras, toggleExtra,
  type OrderExtras
} from "@/lib/order-extras";

type Props = {
  value: OrderExtras;
  onChange: (next: OrderExtras) => void;
  disabled?: boolean;
};

function CheckGroup({
  label, description, options, values, customLabel, disabled, onChange
}: {
  label: string;
  description: string;
  options: readonly string[];
  values: string[];
  customLabel: string;
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  const [custom,setCustom] = useState("");
  const selectedKeys = new Set(values.map(extrasNameKey));
  const customItems = manualExtras(values,options);
  const add = () => {
    if (!custom.trim() || disabled) return;
    onChange(addManualExtra(values,custom));
    setCustom("");
  };
  return <div className="oce-group">
    <div className="oce-group-heading"><strong>{label}</strong><small>{description}</small></div>
    <div className="oce-options">
      {options.map(option=><label key={option} className={"oce-choice" + (selectedKeys.has(extrasNameKey(option)) ? " is-checked" : "")}>
        <input type="checkbox" disabled={disabled} checked={selectedKeys.has(extrasNameKey(option))}
          onChange={event=>onChange(toggleExtra(values,option,event.target.checked))}/>
        <span>{option}</span>
        {selectedKeys.has(extrasNameKey(option)) && <OsIcon name="check" size={16}/>}
      </label>)}
    </div>
    {customItems.length>0 && <div className="oce-manual-list" aria-label={customLabel+" personalizados"}>
      {customItems.map(item=><span className="oce-custom-pill" key={extrasNameKey(item)}>
        {item}
        {!disabled && <button type="button" onClick={()=>onChange(toggleExtra(values,item,false))}
          aria-label={"Quitar "+item} title={"Quitar "+item}><OsIcon name="close" size={15}/></button>}
      </span>)}
    </div>}
    {!disabled && <div className="oce-add-custom">
      <input aria-label={"Agregar "+customLabel.toLowerCase()} placeholder={"Escribir "+customLabel.toLowerCase()+" personalizado…"}
        value={custom} maxLength={140} onChange={e=>setCustom(e.target.value)}
        onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();add();}}}/>
      <button type="button" disabled={!custom.trim() || values.length>=25} onClick={add}>
        <OsIcon name="plus" size={17}/> Agregar
      </button>
    </div>}
  </div>;
}

export function OrderExtrasChecklist({value,onChange,disabled=false}:Props) {
  return <div className="oce">
    <div className="oce-header-copy">
      <strong>Marca solamente lo que realmente hicimos</strong>
      <span>Una selección por cada servicio. Se guarda en el historial de la orden y aparece automáticamente en el mensaje post-servicio.</span>
    </div>
    <div className="oce-groups">
      <CheckGroup label="Servicios complementarios" description="Se mostrarán como servicios realizados"
        options={OIL_CHANGE_SERVICE_PRESETS} values={value.services}
        customLabel="Servicio" disabled={disabled}
        onChange={services=>onChange({...value,services})}/>
      <CheckGroup label="Cortesías y regalos" description="Se mostrarán como atenciones de cortesía"
        options={OIL_CHANGE_COURTESY_PRESETS} values={value.bonuses}
        customLabel="Cortesía" disabled={disabled}
        onChange={bonuses=>onChange({...value,bonuses})}/>
    </div>
    <label className="oce-notes">
      <span><OsIcon name="receipt" size={17}/> Notas y observaciones para el cliente</span>
      <textarea value={value.notes} rows={3} maxLength={2000} disabled={disabled}
        onChange={event=>onChange({...value,notes:event.target.value})}
        placeholder="Ej. Se recomendó revisar el estado de las pastillas de freno en la próxima visita."/>
      {!disabled && <small>Opcional. Esta nota también aparecerá en el resumen de WhatsApp del cliente.</small>}
    </label>
    <p className="oce-financial-note">
      <OsIcon name="shield" size={15}/> Estos servicios y cortesías no agregan cargos, ni modifican stock o pagos.
    </p>
  </div>;
}

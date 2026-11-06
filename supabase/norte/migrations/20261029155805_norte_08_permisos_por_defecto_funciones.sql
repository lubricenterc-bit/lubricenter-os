-- En Cabudare estas funciones no tienen permisos explícitos (= ejecución pública por defecto). Se restaura igual en Norte.
grant execute on function
  lubricenter_private.effective_line_role(public.order_items),
  lubricenter_private.finance_cash_notify_owners(uuid,uuid,text,text,uuid),
  lubricenter_private.finance_cash_open_recount_audit(),
  lubricenter_private.finance_cash_review_owner_guard(),
  lubricenter_private.finance_cash_status_alert(),
  lubricenter_private.finance_week_workbench(date,text,integer),
  lubricenter_private.normalize_order_walk_in(),
  lubricenter_private.order_items_reapply_adjustments(),
  lubricenter_private.receivable_fill_currencies(),
  lubricenter_private.setting_number(text,numeric),
  lubricenter_private.staff_action_log(),
  lubricenter_private.staff_can(text),
  lubricenter_private.staff_identity_allowed(),
  lubricenter_private.staff_owner(),
  lubricenter_private.staff_require_owner(),
  lubricenter_private.staff_write_guard()
to public;
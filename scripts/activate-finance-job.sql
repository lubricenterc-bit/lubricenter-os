-- Activation only after deployment, a successful phone test and owner approval.
-- Provision Vault names finance_job_url and finance_job_secret separately.
-- Never paste the private key or invocation secret into this file.
do $$
declare endpoint text; secret text; job bigint;
begin
 select decrypted_secret into endpoint from vault.decrypted_secrets where name='finance_job_url';
 select decrypted_secret into secret from vault.decrypted_secrets where name='finance_job_secret';
 if endpoint is null or endpoint !~ '^https://[^/]+/api/jobs/finance$' or secret is null or length(secret)<32 then raise exception 'Configura URL HTTPS y secreto del programador en Vault'; end if;
 select jobid into job from cron.job where jobname='finance-review-15m';
 if job is not null then perform cron.unschedule(job); end if;
 perform cron.schedule('finance-review-15m','*/15 * * * *',$job$
 select net.http_post(
  url:=(select decrypted_secret from vault.decrypted_secrets where name='finance_job_url'),
  headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='finance_job_secret')),
  body:='{}'::jsonb,timeout_milliseconds:=120000
 );
 $job$);
end $$;

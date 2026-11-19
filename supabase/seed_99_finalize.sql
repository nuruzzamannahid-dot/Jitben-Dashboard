update public.jitben_dod set phone = public.clean_phone(phone);
select count(*) as orders, count(phone) as with_phone from public.jitben_dod;

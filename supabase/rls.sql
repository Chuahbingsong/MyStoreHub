-- MyStore Hub Row Level Security policies
-- Paste directly into the Supabase SQL Editor (run after schema.sql)

-- Enable RLS
alter table stores enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table products enable row level security;
alter table sync_logs enable row level security;

-- stores: users access only rows where user_id = auth.uid()
create policy "stores_select_own" on stores
  for select using (user_id = auth.uid());

create policy "stores_insert_own" on stores
  for insert with check (user_id = auth.uid());

create policy "stores_update_own" on stores
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "stores_delete_own" on stores
  for delete using (user_id = auth.uid());

-- orders: access only if store_id belongs to a store owned by auth.uid()
create policy "orders_select_own" on orders
  for select using (
    exists (
      select 1 from stores
      where stores.id = orders.store_id
        and stores.user_id = auth.uid()
    )
  );

create policy "orders_insert_own" on orders
  for insert with check (
    exists (
      select 1 from stores
      where stores.id = orders.store_id
        and stores.user_id = auth.uid()
    )
  );

create policy "orders_update_own" on orders
  for update using (
    exists (
      select 1 from stores
      where stores.id = orders.store_id
        and stores.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from stores
      where stores.id = orders.store_id
        and stores.user_id = auth.uid()
    )
  );

create policy "orders_delete_own" on orders
  for delete using (
    exists (
      select 1 from stores
      where stores.id = orders.store_id
        and stores.user_id = auth.uid()
    )
  );

-- products: access only if store_id belongs to a store owned by auth.uid()
create policy "products_select_own" on products
  for select using (
    exists (
      select 1 from stores
      where stores.id = products.store_id
        and stores.user_id = auth.uid()
    )
  );

create policy "products_insert_own" on products
  for insert with check (
    exists (
      select 1 from stores
      where stores.id = products.store_id
        and stores.user_id = auth.uid()
    )
  );

create policy "products_update_own" on products
  for update using (
    exists (
      select 1 from stores
      where stores.id = products.store_id
        and stores.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from stores
      where stores.id = products.store_id
        and stores.user_id = auth.uid()
    )
  );

create policy "products_delete_own" on products
  for delete using (
    exists (
      select 1 from stores
      where stores.id = products.store_id
        and stores.user_id = auth.uid()
    )
  );

-- sync_logs: access only if store_id belongs to a store owned by auth.uid()
create policy "sync_logs_select_own" on sync_logs
  for select using (
    exists (
      select 1 from stores
      where stores.id = sync_logs.store_id
        and stores.user_id = auth.uid()
    )
  );

create policy "sync_logs_insert_own" on sync_logs
  for insert with check (
    exists (
      select 1 from stores
      where stores.id = sync_logs.store_id
        and stores.user_id = auth.uid()
    )
  );

create policy "sync_logs_update_own" on sync_logs
  for update using (
    exists (
      select 1 from stores
      where stores.id = sync_logs.store_id
        and stores.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from stores
      where stores.id = sync_logs.store_id
        and stores.user_id = auth.uid()
    )
  );

create policy "sync_logs_delete_own" on sync_logs
  for delete using (
    exists (
      select 1 from stores
      where stores.id = sync_logs.store_id
        and stores.user_id = auth.uid()
    )
  );

-- order_items: access only if order_id belongs to an order owned by auth.uid()
create policy "order_items_select_own" on order_items
  for select using (
    exists (
      select 1 from orders
      join stores on stores.id = orders.store_id
      where orders.id = order_items.order_id
        and stores.user_id = auth.uid()
    )
  );

create policy "order_items_insert_own" on order_items
  for insert with check (
    exists (
      select 1 from orders
      join stores on stores.id = orders.store_id
      where orders.id = order_items.order_id
        and stores.user_id = auth.uid()
    )
  );

create policy "order_items_update_own" on order_items
  for update using (
    exists (
      select 1 from orders
      join stores on stores.id = orders.store_id
      where orders.id = order_items.order_id
        and stores.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from orders
      join stores on stores.id = orders.store_id
      where orders.id = order_items.order_id
        and stores.user_id = auth.uid()
    )
  );

create policy "order_items_delete_own" on order_items
  for delete using (
    exists (
      select 1 from orders
      join stores on stores.id = orders.store_id
      where orders.id = order_items.order_id
        and stores.user_id = auth.uid()
    )
  );

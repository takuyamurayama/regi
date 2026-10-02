export interface WebActor {
  staffId: string;
  role: 'admin' | 'headquarters' | 'manager' | 'cashier';
}
export interface WebStore {
  id: string;
  name: string;
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
export function webActor(settings: unknown): WebActor | undefined {
  const actor = object(object(settings)?.actor);
  if (
    !actor ||
    typeof actor.staffId !== 'string' ||
    !['admin', 'headquarters', 'manager', 'cashier'].includes(String(actor.role))
  )
    return undefined;
  return { staffId: actor.staffId, role: actor.role as WebActor['role'] };
}
export function webTenant(settings: unknown): string | undefined {
  const tenant = object(object(settings)?.tenant);
  return typeof tenant?.id === 'string' ? tenant.id : undefined;
}
export function webStores(settings: unknown): WebStore[] {
  const configuration = object(settings),
    actor = webActor(settings);
  if (!configuration || !actor || !Array.isArray(configuration.stores)) return [];
  let allowed: unknown[] | undefined;
  if (!['admin', 'headquarters'].includes(actor.role)) {
    if (!Array.isArray(configuration.staff)) return [];
    const staff = (configuration.staff as unknown[])
      .map(object)
      .find((entry) => entry?.id === actor.staffId);
    if (!staff || staff.active !== true || !Array.isArray(staff.stores)) return [];
    allowed = staff.stores as unknown[];
  }
  return (configuration.stores as unknown[]).flatMap((value) => {
    const store = object(value);
    return store &&
      typeof store.id === 'string' &&
      typeof store.name === 'string' &&
      (!allowed || allowed.includes(store.id))
      ? [{ id: store.id, name: store.name }]
      : [];
  });
}

export function intentOrigin(
  scope: string,
): { tenantId: string; staffId: string; storeId: string } | undefined {
  try {
    const value: unknown = JSON.parse(scope);
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      !value.every((entry: unknown) => typeof entry === 'string')
    )
      return undefined;
    const [tenantId, staffId, storeId] = value;
    return { tenantId, staffId, storeId };
  } catch {
    return undefined;
  }
}

// The namespace belongs to one private instance. Keep this object name stable
// when an instance changes its hostname, so its stored records stay available.
export function shelf(env: Env) { return env.SHELF.getByName('default'); }

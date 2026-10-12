export default defineNuxtRouteMiddleware(async (to) => {
    const access = useAccess()
    if (!access.managed.value) return
    try { await access.refresh() }
    catch { return navigateTo('/_auth/login', { external: true }) }
    const adminOnly = ['/users', '/keys', '/backups', '/experimental-features', '/search-rules', '/new-instance']
    if (!access.isAdmin.value && adminOnly.some(path => to.path === path || to.path.startsWith(path + '/'))) {
        return navigateTo('/indexes', { replace: true })
    }
    if (to.params.uid && to.path.startsWith('/indexes/')) {
        if (!access.isAdmin.value && !access.user.value?.indexes.includes(String(to.params.uid))) return navigateTo('/indexes', { replace: true })
        if (!access.canManage.value && to.path.endsWith('/edit')) return navigateTo(`/indexes/${encodeURIComponent(String(to.params.uid))}/documents`, { replace: true })
    }
})

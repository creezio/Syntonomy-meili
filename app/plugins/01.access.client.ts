export default defineNuxtPlugin(async () => {
    const access = useAccess()
    access.managed.value = useMeilisearchStore().isSingleInstanceProxyMode
    if (!access.managed.value) return
    try { await access.refresh() }
    catch { window.location.replace('/_auth/login') }
})

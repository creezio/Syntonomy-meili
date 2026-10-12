export type DashboardRole = 'admin' | 'gestionnaire' | 'lecteur'
export type DashboardUser = {
    id: string
    username: string
    displayName: string
    role: DashboardRole
    indexes: string[]
    active: boolean
    createdAt: string
    updatedAt: string
}
export const roleLabels: Record<DashboardRole, string> = {
    admin: 'Administrateur', gestionnaire: 'Gestionnaire', lecteur: 'Lecteur',
}

export function useAccess() {
    const user = useState<DashboardUser | null>('dashboard-user', () => null)
    const managed = useState<boolean>('dashboard-access-managed', () => false)
    const isAdmin = computed(() => !managed.value || user.value?.role === 'admin')
    const canManage = computed(() => !managed.value || user.value?.role === 'admin' || user.value?.role === 'gestionnaire')
    const roleLabel = computed(() => user.value ? roleLabels[user.value.role] : '')
    async function refresh() {
        const result = await $fetch<{ user: DashboardUser }>('/api/access/me')
        user.value = result.user
    }
    async function logout() {
        await $fetch('/_auth/logout', { method: 'POST', redirect: 'manual' })
        window.location.assign('/_auth/login')
    }
    return { user, managed, isAdmin, canManage, roleLabel, refresh, logout }
}

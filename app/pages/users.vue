<script setup lang="ts">
import type { DashboardUser, DashboardRole } from '@/composables/useAccess'
import { roleLabels } from '@/composables/useAccess'

definePageMeta({ layout: 'app', title: 'Utilisateurs', breadcrumbs: [{ label: 'Dashboard', to: '/dashboard' }, { label: 'Utilisateurs' }] })
const access = useAccess()
const toast = useToast()
const users = ref<DashboardUser[]>([])
const indexOptions = ref<string[]>([])
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const modalOpen = ref(false)
const editingId = ref<string | null>(null)
const passwordVisible = ref(false)
const form = reactive({ username: '', displayName: '', password: '', role: 'lecteur' as DashboardRole, indexes: [] as string[], active: true })
const roles = [
    { label: 'Administrateur', value: 'admin', description: 'Tous les index, utilisateurs et réglages de l’instance.' },
    { label: 'Gestionnaire', value: 'gestionnaire', description: 'Documents et réglages des index attribués.' },
    { label: 'Lecteur', value: 'lecteur', description: 'Consultation et recherche dans les index attribués.' },
]
const selectedRole = computed(() => roles.find(x => x.value === form.role))
const isOwnAccount = computed(() => editingId.value === access.user.value?.id)

async function load() {
    loading.value = true
    try {
        const [accounts, inventory] = await Promise.all([
            $fetch<{ users: DashboardUser[] }>('/api/access/users'),
            $fetch<{ results: { uid: string }[] }>('/api/meilisearch/indexes', { query: { limit: 10000 } }),
        ])
        users.value = accounts.users
        indexOptions.value = inventory.results.map(x => x.uid).sort()
    } catch (cause: any) { error.value = cause.data?.message ?? 'Impossible de charger les utilisateurs.' }
    finally { loading.value = false }
}
await load()

function openEditor(user?: DashboardUser) {
    editingId.value = user?.id ?? null
    Object.assign(form, { username: user?.username ?? '', displayName: user?.displayName ?? '', password: '', role: user?.role ?? 'lecteur', indexes: user?.indexes.filter(x => x !== '*') ?? [], active: user?.active ?? true })
    passwordVisible.value = false
    error.value = ''
    modalOpen.value = true
}
async function save() {
    saving.value = true
    error.value = ''
    try {
        const payload = { username: form.username, displayName: form.displayName || form.username, role: form.role, indexes: form.role === 'admin' ? ['*'] : form.indexes, active: form.active, ...(!editingId.value || form.password ? { password: form.password } : {}) }
        await $fetch(editingId.value ? `/api/access/users/${editingId.value}` : '/api/access/users', { method: editingId.value ? 'PATCH' : 'POST', body: payload })
        form.password = ''
        modalOpen.value = false
        await access.refresh()
        await load()
        toast.add({ title: 'Utilisateur enregistré', color: 'success', description: 'Les permissions sont appliquées immédiatement.' })
    } catch (cause: any) { error.value = cause.data?.message ?? 'Impossible d’enregistrer cet utilisateur.' }
    finally { saving.value = false }
}
const { confirmAction } = useConfirmAction()
function remove(user: DashboardUser) {
    void confirmAction({ title: 'Supprimer cet utilisateur ?', description: `Le compte ${user.username} et ses accès seront supprimés. Les index et leurs documents seront conservés.`, confirmLabel: 'Supprimer' }, async () => {
        try { await $fetch(`/api/access/users/${user.id}`, { method: 'DELETE' }); await load() }
        catch (cause: any) { error.value = cause.data?.message ?? 'Suppression refusée.' }
    })
}
function generatePassword() {
    const bytes = crypto.getRandomValues(new Uint8Array(24))
    form.password = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
    passwordVisible.value = true
}
watch(modalOpen, open => { if (!open) { form.password = ''; passwordVisible.value = false } })
</script>

<template>
    <AppDashboardPanel id="users">
        <template #actions>
            <AppPageActions>
                <UButton aria-label="Actualiser les utilisateurs" icon="i-lucide-refresh-cw" color="neutral" variant="ghost" :loading="loading" @click="load" />
                <UButton label="Nouvel utilisateur" icon="i-lucide-user-plus" @click="openEditor()" />
            </AppPageActions>
        </template>
        <UAlert title="Des accès adaptés à chaque utilisateur" description="Les administrateurs accèdent à toute l’instance. Les gestionnaires et lecteurs accèdent uniquement aux index que vous leur attribuez." icon="i-lucide-shield-check" color="info" variant="subtle" />
        <UAlert v-if="error && !modalOpen" :description="error" title="Opération refusée" color="error" variant="subtle" />
        <UCard :ui="{ body: 'p-0 sm:p-0' }">
            <div class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead class="bg-elevated/50 text-left text-muted"><tr><th class="p-4">Utilisateur</th><th class="p-4">Rôle</th><th class="p-4">Index attribués</th><th class="p-4">État</th><th class="p-4 text-right">Actions</th></tr></thead>
                    <tbody class="divide-y divide-default">
                        <tr v-for="user in users" :key="user.id">
                            <td class="p-4"><div class="font-semibold text-highlighted">{{ user.displayName }}</div><div class="text-muted">{{ user.username }}{{ user.id === access.user.value?.id ? ' · vous' : '' }}</div></td>
                            <td class="p-4"><UBadge :color="user.role === 'admin' ? 'primary' : 'neutral'" variant="subtle">{{ roleLabels[user.role] }}</UBadge></td>
                            <td class="p-4"><span v-if="user.role === 'admin'">Tous les index</span><div v-else class="flex max-w-xl flex-wrap gap-1"><UBadge v-for="uid in user.indexes.slice(0, 3)" :key="uid" color="neutral" variant="outline">{{ uid }}</UBadge><span v-if="user.indexes.length > 3" class="text-muted">+{{ user.indexes.length - 3 }}</span><span v-if="!user.indexes.length" class="text-muted">Aucun index</span></div></td>
                            <td class="p-4"><UBadge :color="user.active ? 'success' : 'neutral'" variant="subtle">{{ user.active ? 'Actif' : 'Désactivé' }}</UBadge></td>
                            <td class="p-4"><div class="flex justify-end gap-2"><UButton label="Modifier" icon="i-lucide-pencil" variant="outline" color="neutral" @click="openEditor(user)" /><UButton v-if="user.id !== access.user.value?.id" :aria-label="`Supprimer ${user.username}`" icon="i-lucide-trash-2" variant="ghost" color="error" @click="remove(user)" /></div></td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <template #footer><p class="text-sm text-muted">{{ users.length }} compte{{ users.length > 1 ? 's' : '' }} · Les mots de passe sont stockés sous forme de hash.</p></template>
        </UCard>
        <UModal v-model:open="modalOpen" :title="editingId ? 'Modifier l’utilisateur' : 'Nouvel utilisateur'" description="Choisissez son rôle et les index auxquels il peut accéder." :dismissible="!saving" :ui="{ content: 'sm:max-w-2xl' }">
            <template #body>
                <form id="user-form" class="space-y-5" @submit.prevent="save">
                    <UAlert v-if="error" :description="error" title="Vérifiez les informations" color="error" variant="subtle" />
                    <div class="grid gap-4 sm:grid-cols-2">
                        <UFormField label="Nom affiché" name="displayName"><UInput v-model="form.displayName" class="w-full" maxlength="80" autocomplete="off" /></UFormField>
                        <UFormField label="Identifiant" name="username" required><UInput v-model="form.username" class="w-full" minlength="3" maxlength="64" required autocomplete="off" /></UFormField>
                    </div>
                    <UFormField label="Rôle" name="role" :description="selectedRole?.description"><USelect v-model="form.role" :items="roles" value-key="value" class="w-full" :disabled="isOwnAccount" /></UFormField>
                    <UAlert v-if="form.role === 'admin'" title="Accès à tous les index" description="Ce rôle peut aussi gérer les comptes, les clés API et les sauvegardes." icon="i-lucide-shield" color="info" variant="subtle" />
                    <UFormField v-else label="Index attribués" name="indexes" description="Vous pouvez sélectionner plusieurs index. Sans attribution, le compte ne voit aucun index.">
                        <USelectMenu v-model="form.indexes" :items="indexOptions" multiple searchable class="w-full" placeholder="Rechercher et sélectionner des index" :virtualize="true" />
                        <div v-if="form.indexes.length" class="mt-2 flex flex-wrap gap-1"><UBadge v-for="uid in form.indexes" :key="uid" color="neutral" variant="subtle">{{ uid }}</UBadge></div>
                    </UFormField>
                    <UFormField :label="editingId ? 'Nouveau mot de passe' : 'Mot de passe'" name="password" :required="!editingId" :description="editingId ? 'Laissez vide pour conserver le mot de passe. Minimum 12 caractères pour le changer.' : 'Minimum 12 caractères. Transmettez-le à la personne concernée.'">
                        <div class="flex gap-2"><UInput v-model="form.password" :type="passwordVisible ? 'text' : 'password'" :required="!editingId" minlength="12" maxlength="256" autocomplete="new-password" class="flex-1" /><UButton :aria-label="passwordVisible ? 'Masquer le mot de passe' : 'Afficher le mot de passe'" :icon="passwordVisible ? 'i-lucide-eye-off' : 'i-lucide-eye'" color="neutral" variant="outline" @click="passwordVisible = !passwordVisible" /><UButton label="Générer" color="neutral" variant="outline" @click="generatePassword" /></div>
                    </UFormField>
                    <USwitch v-model="form.active" label="Compte actif" :disabled="isOwnAccount" />
                    <p v-if="editingId" class="text-sm text-muted">Modifier ce compte invalide ses sessions existantes. L’utilisateur devra se reconnecter.</p>
                </form>
            </template>
            <template #footer><div class="flex w-full justify-end gap-2"><UButton label="Annuler" color="neutral" variant="outline" :disabled="saving" @click="modalOpen = false" /><UButton :label="editingId ? 'Enregistrer' : 'Créer le compte'" type="submit" form="user-form" :loading="saving" /></div></template>
        </UModal>
    </AppDashboardPanel>
</template>

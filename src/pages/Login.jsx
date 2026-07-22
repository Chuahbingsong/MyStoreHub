import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Eye, EyeOff, Loader2, ShoppingBag } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { supabase } from '@/lib/supabase'
import { useTranslation } from '@/lib/i18n/I18nContext'

export default function Login() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [rememberMe, setRememberMe] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()

    if (!email.trim() || !password) {
      setError(t('login.validationError'))
      return
    }

    setError('')
    setLoading(true)

    const { error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })

    setLoading(false)

    if (authError) {
      // authError.message is Supabase's own (English) auth error text, not
      // authored by this app — left untranslated, same as any other
      // upstream/data string. Our own fallback (when Supabase returns no
      // message at all) does go through t().
      setError(authError.message || t('login.genericError'))
      return
    }

    navigate('/dashboard')
  }

  return (
    <div className="min-h-screen bg-[#FAF9F6] px-6 pb-10 pt-[20vh]">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#2563EB]">
            <ShoppingBag className="h-7 w-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-[#1F2937]">MyStore Hub</h1>
          <p className="mt-1 text-sm text-[#6B7280]">{t('login.subtitle')}</p>
        </div>

        <form noValidate onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email" className="text-[#6B7280]">
              {t('login.emailLabel')}
            </Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              aria-invalid={!!error}
              className="h-11 !bg-white border-[#E5E7EB] text-[#1F2937] placeholder:text-gray-400"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-[#6B7280]">
              {t('login.passwordLabel')}
            </Label>
            <div className="relative">
              <Input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                aria-invalid={!!error}
                className="h-11 !bg-white border-[#E5E7EB] pr-10 text-[#1F2937] placeholder:text-gray-400"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                disabled={loading}
                aria-label={showPassword ? t('login.hidePasswordAria') : t('login.showPasswordAria')}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-[#6B7280] hover:text-[#1F2937] disabled:opacity-50"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm text-[#6B7280]">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                disabled={loading}
                className="h-4 w-4 rounded border-gray-300 bg-white accent-[#2563EB]"
              />
              {t('login.rememberMe')}
            </label>
            <Link to="/forgot-password" className="text-sm font-medium text-[#2563EB] hover:underline">
              {t('login.forgotPassword')}
            </Link>
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}

          <Button
            type="submit"
            disabled={loading}
            className="h-11 w-full bg-[#2563EB] text-white hover:bg-[#2563EB]/90"
          >
            {loading ? (
              <>
                <Loader2 className="animate-spin" />
                {t('login.signingIn')}
              </>
            ) : (
              t('login.signIn')
            )}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-[#6B7280]">
          {t('login.noAccount')}{' '}
          <Link to="/register" className="font-medium text-[#2563EB] hover:underline">
            {t('login.register')}
          </Link>
        </p>
      </div>
    </div>
  )
}

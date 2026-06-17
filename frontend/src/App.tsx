import { Routes, Route } from 'react-router-dom'
import { MemphisGate } from '@thebes/sdk'
import { Layout } from './components/Layout'
import { Browse } from './pages/Browse'
import { ListingPage } from './pages/Listing'
import { Mine } from './pages/Mine'
import { Admin } from './pages/Admin'

export function App() {
  return (
    <MemphisGate appName="Harbor" tagline="Sign in to reserve.">
      <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Browse />} />
        <Route path="/l/:id" element={<ListingPage />} />
        <Route path="/mine" element={<Mine />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="*" element={<Browse />} />
      </Route>
    </Routes>
    </MemphisGate>
  )
}

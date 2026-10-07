import { describe, expect, it } from 'vitest'
import { slugFromHost, slugify, slugProblem } from './tenant-slug'

describe('tenant slug', () => {
  it('accepts plain names and refuses bad shapes and reserved ones', () => {
    expect(slugProblem('bayleaf')).toBeNull()
    expect(slugProblem('bay-leaf-2')).toBeNull()
    for (const bad of ['a', 'ab', '-bay', 'bay-', 'Bay', 'bay_leaf', 'bay.leaf', 'bay--leaf', 'x'.repeat(33)]) expect(slugProblem(bad), bad).toBe('invalid')
    for (const reserved of ['www', 'api', 'admin', 'ops', 'restiq', 'status']) expect(slugProblem(reserved), reserved).toBe('reserved')
  })

  it('suggests a slug from a company name, dropping company suffixes', () => {
    expect(slugify('Bay Leaf Kitchens Pvt Ltd')).toBe('bay-leaf-kitchens')
    expect(slugify('Harbour Bistro Pty Ltd')).toBe('harbour-bistro')
    expect(slugify("  Café  Déjà Vu!! ")).toBe('cafe-deja-vu')
    expect(slugProblem(slugify('AB'))).toBeNull()
    expect(slugProblem(slugify('Restaurant of the Very Long Name That Never Seems To End Anywhere'))).toBeNull()
  })

  it('reads the slug from a host under the base domain, and nothing else', () => {
    expect(slugFromHost('bayleaf.idelta.com.au', 'idelta.com.au')).toBe('bayleaf')
    expect(slugFromHost('BayLeaf.Idelta.com.au:443', 'idelta.com.au')).toBe('bayleaf')
    expect(slugFromHost('idelta.com.au', 'idelta.com.au')).toBeNull()
    expect(slugFromHost('a.b.idelta.com.au', 'idelta.com.au')).toBeNull()
    expect(slugFromHost('bayleaf.example.com', 'idelta.com.au')).toBeNull()
    expect(slugFromHost('evilidelta.com.au', 'idelta.com.au')).toBeNull()
  })
})

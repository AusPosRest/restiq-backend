import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { isLanUrl } from './sync.dtos'

describe('isLanUrl (#301)', () => {
  it.each(['http://192.168.1.20:8080', 'https://10.0.0.5:443/', 'http://172.31.255.255:1', 'http://till-1.local:8080', 'http://10.0.0.1:80'])('accepts %s', (url) => {
    expect(isLanUrl(url)).toBe(true)
  })

  it.each([
    'http://8.8.8.8:8080',
    'http://192.168.1.20',
    'ftp://10.0.0.1:21',
    'http://172.32.0.1:80',
    'http://10.0.0.256:80',
    'http://010.0.0.1:80',
    'http://10.0.0.1:0',
    'http://10.0.0.1:65536',
    'http://local:80',
    'http://evil.com:80',
    'http://10.0.0.1:80/path',
    'http://user@10.0.0.1:80',
    'http://10.0.0.1.local.evil:80',
  ])('refuses %s', (url) => {
    expect(isLanUrl(url)).toBe(false)
  })
})

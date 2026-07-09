import cityGroupData from '@geekgeekrun/geek-auto-start-chat-with-boss/cityGroup.mjs'

let flatCityListCache = null

export function resolveCityCode (value) {
  const normalized = String(value ?? '').trim()
  if (!normalized) return ''
  if (/^\d+$/.test(normalized)) return normalized
  const city = getFlatCityList().find(item => item.name === normalized)
  return city?.code ? String(city.code) : ''
}

function getFlatCityList () {
  if (flatCityListCache) return flatCityListCache
  flatCityListCache = []
  for (const group of cityGroupData?.zpData?.cityGroup ?? []) {
    for (const city of group.cityList ?? []) {
      flatCityListCache.push({ ...city, firstChar: group.firstChar })
    }
  }
  for (const city of cityGroupData?.zpData?.hotCityList ?? []) {
    flatCityListCache.push({ ...city, firstChar: city.firstChar })
  }
  return flatCityListCache
}

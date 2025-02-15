import { ok } from 'assert'
import { ObjectId } from 'mongodb'
import { transact, derivation } from 'derivable'
import * as R from 'ramda'
import invariant from 'invariant'

const debug = require('debug')('u5-derive')

const derivedPropsKey = process.env.DERIVED_PROPS_KEY || '_D'

const updateCache = (cache, domain, key, counter) => {

  invariant(domain.root, 'Domain needs a "root" property')
  invariant(domain.types && Object.keys(domain.types).length > 0, 'Domain needs "types" property with at least one type')

  debug(`updateCache, domain ${ domain.root }, key=${ key }, counter=${ counter }`)

  const findAndTraverse = (self, type, typeDef, relName /* other */, rel /* otherDef */, many = true) => {

    const other = rel.of || relName
    ok(other, `name for association ${ relName } missing`)
    const otherDef = domain.types[other]
    ok(otherDef, `unable to determine type for assocation '${ relName }' of '${ type }'`)

    const loader = cache.getLoader(other)

    const query = many || rel.targetTypeHasForeignKey
      ? {
          [rel.foreignKey]: ObjectId(self._id)
        }
      : {
          _id: ObjectId(self[rel.foreignKey])
        }

    return cache.mongo.then(db => db.collection(other).find(query).toArray())
    .then(otherInstances => {

      // console.log('findAndTraverse, otherInstances', otherInstances.map(i => i._id))

      otherInstances.forEach(i => loader.clear(i._id).prime(i._id, i))
      debug('findAndTraverse, about to assign', relName, self._id, otherInstances.length)
      self[relName] = many
        ? derivation(() => otherInstances)
        : derivation(() => otherInstances.length > 0 ? otherInstances[0] : null)
      return otherInstances
    })
    .then(otherInstances => Promise.all(
      otherInstances.map(i => traverseToLoad(other, i._id))
    ))
  }

  function traverseToLoad(type, key) {
    const loader = cache.getLoader(type)
    return loader.load(key)
    .then(self => {
      const typeDef = domain.types[type]
      const { hasMany, hasOne } = typeDef

      if (self.__version >= counter) {
        // concurrent load may result in newer version, should be idempotent
        // nevertheless
        console.log('Breaking recursion', type, key)
        return Promise.resolve()
      }
      self.__version = counter

      const hasManyPromises = Object.keys(hasMany || {})
      .map(relName => findAndTraverse(
        self, type, typeDef, relName, hasMany[relName]
      ))

      // TODO: almost the same as for 'hasMany' (only thing different is probably
      // how `self` should refer to the other(s)?)
      const hasOnePromises = Object.keys(hasOne || {})
      .map(relName => findAndTraverse(
        self, type, typeDef, relName, hasOne[relName], false /* not hasMany... */
      ))

      return Promise.all([ ...hasManyPromises, ...hasOnePromises ])
    })
  }

  return traverseToLoad(domain.root, key)
}

const derive = (cache, domain, key) => {

  function traverse(type, o, cb) {

    const traverseAssociation = (self, type, typeDef, relName, rel, many = true) => {

      ok(self[relName], `Missing '${ relName } from instance of '${ type }'`)

      const other = rel.of || relName
      const others = self[relName].get()

      if (many) {
        others.map(instance => traverse(other, instance, cb))
      } else {
        if (others) { // could be null
          return traverse(other, others, cb)
        }
      }
    }

    // console.log('traverse (cb)', type, o)
    if (!cb(type, o)) {
      debug('aborting traversal, callback returned false')
    }

    const typeDef = domain.types[type]
    const { hasMany, hasOne } = typeDef
    // console.log('derive.traverse, o', o)
    Object.keys(hasMany || {})
    .map(relName => traverseAssociation(
      o, type, typeDef, relName, hasMany[relName]
    ))

    Object.keys(hasOne || {})
    .map(relName => traverseAssociation(
      o, type, typeDef, relName, hasOne[relName], false
    ))
  }

  const loader = cache.getLoader(domain.root)
  return loader.load(key)
  .then(self => {
    transact(() => {
      traverse(domain.root, self, (typeName, o) => {
        const type = domain.types[typeName]
        // console.log('DERIVE?', type, o._id)
        Object.keys(type.derivedProps || []).map(propName => {
          const prop = type.derivedProps[propName]
          o[propName] = derivation(() => prop.f(o))
        })
        return true
      })
    })

    // store / update derived props
    const updates = []
    traverse(domain.root, self, (typeName, o) => {
      const type = domain.types[typeName]
      const derivedProps = {}
      Object.keys(type.derivedProps || []).map(propName => {
        // console.log(`o=${ o._id }, ${ propName }=${ o[propName].get() }`)
        derivedProps[propName] = o[propName].get()
      })
      // console.log(`derivedProps(old)=`, o[derivedPropsKey], derivedProps)
      if (!o[derivedPropsKey] || !R.equals(o[derivedPropsKey], derivedProps)) {
        debug(`must update ${ typeName } ${ o._id }`)
        updates.push(cache.mongo.then(db => db.collection(typeName).findOneAndUpdate({
          _id: ObjectId(o._id)
        }, {
          $set: { [derivedPropsKey]: derivedProps }
        })))
      }
      return true
    })
    return Promise.all(updates)

  })
}

let counter = 0
export const update = (cache, domain, key) => updateCache(cache, domain, key, ++counter)
.then(() => derive(cache, domain, key))

export const resync = (cache, domain) => cache.mongo
.then(db => db.collection(domain.root))
.then(coll => coll.find({}, { _id: 1 }).toArray())
.then(docs => docs
  .map(doc => doc._id)
  .map(id => updateCache(cache, domain, id, ++counter)
    .then(() => derive(cache, domain, id))
  )
)

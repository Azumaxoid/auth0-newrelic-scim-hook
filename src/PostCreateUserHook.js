/**
 @param {object} user - The user being created
 @param {string} user.id - user id
 @param {string} user.tenant - Auth0 tenant name
 @param {string} user.username - user name
 @param {string} user.email - email
 @param {boolean} user.emailVerified - is e-mail verified?
 @param {string} user.phoneNumber - phone number
 @param {boolean} user.phoneNumberVerified - is phone number verified?
 @param {object} user.user_metadata - user metadata
 @param {object} user.app_metadata - application metadata
 @param {object} context - Auth0 connection and other context info
 @param {string} context.requestLanguage - language of the client agent
 @param {object} context.connection - information about the Auth0 connection
 @param {object} context.connection.id - connection id
 @param {object} context.connection.name - connection name
 @param {object} context.connection.tenant - connection tenant
 @param {object} context.webtask - webtask context
 @param {function} cb - function (error, response)
 */

const https = require('https')

// connection.name : new relic group
const groupNames = {
    "Username-Password-Authentication": "Auth0 User"
}

const urlBase = 'https://scim-provisioning.service.newrelic.com/scim/v2/';

/**
 *
 * @param newrelicToken
 * @param method
 * @param action
 * @param data
 * @param requestParameter
 * @returns {Promise<unknown>}
 */
const request = (newrelicToken, method, action, data, requestParameter = '') => {
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${newrelicToken}`
        }
    }
    return new Promise(res => {
        const request = https.request(urlBase+action+requestParameter, options, response => {
            var data = [];
            response.on('data', function(chunk) {
                data.push(chunk);
            }).on('end', function() {
                res(JSON.parse(data));
            });
        });
        if (!!data) {
            request.write(JSON.stringify(data));
        }
        request.end();
    });
}

/**
 *
 * @param newrelicToken // New Relic Domain Token from secret
 * @param groupName // group name
 * @returns {Promise<string>} // group id
 */
const queryGroup = async (newrelicToken, groupName) => {
    const storedGroup = await request(newrelicToken, 'GET', 'Groups', null, encodeURI(`?filter=displayName eq "${groupName}"`))
    if (!storedGroup || !storedGroup.Resources || storedGroup.Resources.length === 0) {
        return null
    }
    return storedGroup.Resources[0].id
}

/**
 *
 * @param newrelicToken // New Relic Domain Token from secret
 * @param groupName // group name
 * @returns {Promise<string>} // group id
 */
const createGroup = async (newrelicToken, groupName) => {
    const groupData = {
        "schemas": [ "urn:ietf:params:scim:schemas:core:2.0:Group" ],
        "displayName": groupName,
        "members": []
    }
    const createdGroup = await request(newrelicToken, 'POST', 'Groups', groupData)
    if (!createdGroup || !createdGroup.id) {
        return null
    }
    return createdGroup.id
}

/**
 *
 * @param newrelicToken // New Relic Domain Token from secret
 * @param userId // user id
 * @param groupId // group id
 * @returns {Promise<null|*>}
 */
const addGroupToUser = async (newrelicToken, userId, groupId) => {
    const groupData = {
        "schemas": [
            "urn:ietf:params:scim:api:messages:2.0:PatchOp"
        ],
        "Operations": [{
            "op": "Add",
            "path": "members",
            "value": [{
                "value": userId
            }]
        }]
    }
    await request(newrelicToken, 'PATCH', `Groups/${groupId}`, groupData)
}

/**
 *
 * @param newrelicToken // New Relic Domain Token from secret
 * @param userId // Aut0 user id
 * @returns {Promise<string>} // user id
 */
const queryUser = async (newrelicToken, userId) => {
    const createdUser = await request(newrelicToken, 'GET', 'Groups', null, encodeURI(`?filter=externalId eq "${userId}"`))
    if (!createdUser || !createdUser.Resources || createdUser.Resources.length === 0) {
        return null
    }
    return createdUser.Resources[0].id
}

/**
 *
 * @param newrelicToken // New Relic Domain Token from secret
 * @param id // Auth0 user id
 * @param email // email
 * @param userName // user name
 * @returns {Promise<null|*>}
 */
const createUser = async (newrelicToken, id, email, userName) => {
    const userData = {
        "schemas": [ "urn:ietf:params:scim:schemas:core:2.0:User" ],
        "externalId": id,
        "userName": email,
        "name": {
            "familyName": "",
            "givenName": userName
        },
        "emails": [{
            "value": email,
            "primary": true
        }],
        "timezone": "Japan/Tokyo",
        "active": true,
        "groups": []
    }

    const createdUser = await request(newrelicToken, 'POST', 'Users', userData)
    if (!createdUser || !createdUser.id) {
        return null
    }
    return createdUser.id
}

/**
 *
 * @param newrelicToken // New Relic Domain Token from secret
 * @param userId // newrelic user id
 * @param userName // user name
 * @returns {Promise<void>}
 */
const updateUser = async (newrelicToken, userId, userName) => {
    const userData = {
        "schemas": [
            "urn:ietf:params:scim:schemas:core:2.0:User"
        ],
        "name": {
            "familyName": "",
            "givenName": userName
        }
    }
    await request(newrelicToken, 'PUT', `Users/${userId}`, userData)
}


module.exports = async (user, context, cb) => {
    const newrelicToken = context.webtask.secrets.NR_DOMAIN_TOKEN

    // グループの存在有無の確認
    let groupId = await queryGroup(newrelicToken, context.connection.name)
    // グループが無い場合
    if (!groupId) {
        // グループの作成
        groupId = await createGroup(newrelicToken, context.connection.name)
    }
    // ユーザーの存在有無の確認
    // Auth0にはDeleteフックがないので、削除が必要。検索しやすくするためにemailベースでIDを作成
    // Deleteフックができればuser.idを使う方が良い
    const externalId = user.email.replace(/[\+@\.]/g, '_')
    let userId = await queryUser(newrelicToken, externalId)
    // ユーザーがいない場合
    if (!userId) {
        // ユーザーの作成
        userId = await createUser(newrelicToken, externalId, user.email, user.name)
    } else {
        // ユーザーがいる場合
        // ユーザー情報の更新
        await updateUser(newrelicToken, userId, user.name)
    }
    console.log(`userId: ${userId} groupId: ${groupId}`)
    await addGroupToUser(newrelicToken, userId, groupId)
    cb();
};

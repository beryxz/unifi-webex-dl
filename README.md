# UNIFI-WEBEX-DL

> Download recorded lessons from unifi webex platform passing by the Moodle platform.

## Quick Start

Install project dependencies: `npm install`

Copy `config.example.json` to `config.json` and change credentials and courses ids accordingly.

Run the app with: `npm start`

## How it works

### Login to Moodle

> GET <https://e-l.unifi.it/login/index.php>

Get `MoodleSession` cookie from header and in the response body match the first

`<input type="hidden" name="logintoken" value="P1pp0Plu70">`.

Then post the form with the loginToken.

> POST <https://e-l.unifi.it/login/index.php>

The request should match the following

```http
Content-Type: application/x-www-form-urlencoded
Cookie: MoodleSession=***

{
    anchor: null,
    logintoken: 'P1pp0Plu70',
    username: 00000,
    password: *****,
    rememberusername: 0
}
```

Update `MoodleSession` Cookie from Set-Cookie response header.

Verify that everything is fine.

> GET <https://e-l.unifi.it/login/index.php>
> Cookie: MoodleSession

If the body doesn't contain `loginerrormessage`, you should be logged in.

### Get Webex Id

To launch webex we have to get the webex id relative to the moodle course id.

> GET <https://e-l.unifi.it/course/view.php?id=42>

In the body match the launch url. Either of these:

- `https://e-l.unifi.it/mod/lti/launch.php?id=***`
- `https://e-l.unifi.it/mod/lti/view.php?id=***`

Retrieve the id parameter

### Get Webex launch parameters

> GET <https://e-l.unifi.it/mod/lti/launch.php?id=1337>
> Cookie: MoodleSession

Serialize from the html body all the name attributes in input tags

### Launch Webex

> POST <https://lti.educonnector.io/launches>
> Content-Type: application/x-www-form-urlencoded

In the body send the parameters retrieved [from Moodle](#get-webex-launch-parameters)

From the response:

Get cookies [`ahoy_visitor`, `ahoy_visit`, `_ea_involvio_lti_session`]

Extract the JWT from the response body:
`&quot;json_web_token&quot;:&quot;eyJh***.****.****&quot;`

### Get Webex course recordings

> GET <https://lti.educonnector.io/api/webex/recordings>

The request headers should match the following

```html
Authorization: Bearer json_web_token
Cookie: ahoy_visitor=***,ahoy_visit=***,_ea_involvio_lti_session=***
```

The response is an object like the following

```json
[
    {
        "created_at": "",
        "duration_hour": 0,
        "duration_min": 0,
        "duration_sec": 0,
        "file_url": "https://unifirenze.webex.com/unifirenze/lsr.php?RCID=******",
        "format": "",
        "id": 0,
        "name": "",
        "password": "",
        "recording_url": "https://unifirenze.webex.com/unifirenze/ldr.php?RCID=******",
        "timezone": "",
        "updated_at": ""
    }, {
        ...
    }, ...
]
```

### Download a recording

> GET `file_url`

Get all `name` and `values` attributes from the input tags.

> POST <https://unifirenze.webex.com/svc3300/svccomponents/servicerecordings/recordingpasswordcheck.do>

The body should contain the input attributes from the previous request and the password of the course

Then match `var href='https://unifirenze.webex.com/mw3300/mywebex/nbrshared.do?siteurl=unifirenze-en&action=publishfile&recordID=***&serviceRecordID=***&recordKey=***';`

> GET `matched nbrshared.do url`

Match the following part

```js
    function download(){
        document.title="Download file";
        var recordId = 000;
        var serviceRecordId = 000;
        var prepareTicket = '******';
        var comeFrom = '';
        var url = "https://unifirenze.webex.com/mw3300/mywebex/nbrPrepare.do?siteurl=unifirenze-en" + "&recordid=" + recordId+"&prepareTicket=" + prepareTicket;
        if (serviceRecordId > 0) {
            url = url + "&serviceRecordId=" + serviceRecordId;
        }

        _refreshIFrame(url,1);
    }
```

> GET `matched nbrPrepare.do url`

Match `window.parent.func_prepare('***','***','***');`

This is the function declaration `func_prepare(status, url, ticket)` that i'll reefer to.

Check the `status` that could be one of the following ["OKOK", "Preparing", "Error", "null if bug?"]

- Error:
  - Throw error and skip this file
- Preparing:
  - Fetch again GET "https://unifirenze.webex.com/mw3300/mywebex/nbrPrepare.do?siteurl=unifirenze-en" + `url`
- OKOK:
  - Match `var downloadUrl = 'https://***.webex.com/nbr/MultiThreadDownloadServlet?siteid=***&recordid=***&confid=***&language=1&userid=***&serviceRecordID=***&ticket=' + ticket;`

> GET `MultiThreadDownloadServlet`

The response is the `name`.`format` (from the recording object).

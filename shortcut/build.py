#!/usr/bin/env python3
"""Build the iPhone Shortcut as an unsigned .shortcut plist.

Generic copy (asks for server URL and token on import):
    python3 shortcut/build.py out.shortcut
Personal copy (values baked in, no questions):
    python3 shortcut/build.py out.shortcut --server https://dl.example.com --token XXXX

Then sign it on a Mac:
    shortcuts sign --mode anyone --input out.shortcut --output Clearatos.shortcut
"""
import argparse
import plistlib
import uuid

OBJ = "￼"  # placeholder char where a variable is inserted in text


def uid():
    return str(uuid.uuid4()).upper()


def var(name):
    return {"Type": "Variable", "VariableName": name}


def out(action_uuid, name):
    return {"Type": "ActionOutput", "OutputUUID": action_uuid, "OutputName": name}


def ext_input():
    return {"Type": "ExtensionInput"}


def attach(ref):
    return {"Value": ref, "WFSerializationType": "WFTextTokenAttachment"}


def text(*parts):
    """Build a text field from plain strings and variable refs."""
    s, ranges = "", {}
    for p in parts:
        if isinstance(p, str):
            s += p
        else:
            ranges[f"{{{len(s)}, 1}}"] = p
            s += OBJ
    return {"Value": {"string": s, "attachmentsByRange": ranges}, "WFSerializationType": "WFTextTokenString"}


def dict_field(pairs):
    items = [{"WFItemType": 0, "WFKey": text(k), "WFValue": text(*v)} for k, v in pairs]
    return {"Value": {"WFDictionaryFieldValueItems": items}, "WFSerializationType": "WFDictionaryFieldValue"}


def action(ident, **params):
    return {"WFWorkflowActionIdentifier": f"is.workflow.actions.{ident}", "WFWorkflowActionParameters": params}


def cond_input(ref):
    return {"Type": "Variable", "Variable": attach(ref)}


def build(server, token):
    acts = []

    def add(ident, **p):
        u = p.pop("UUID", None) or uid()
        acts.append(action(ident, UUID=u, **p))
        return u

    # 0, 1: settings (these two become import questions in the generic copy)
    a_server = add("gettext", WFTextActionText=server)
    add("setvariable", WFVariableName="Server", WFInput=attach(out(a_server, "Text")))
    a_token = add("gettext", WFTextActionText=token)
    add("setvariable", WFVariableName="Token", WFInput=attach(out(a_token, "Text")))

    # Link = shared input as text (share sheet URL, shared text, or clipboard)
    a_link = add("gettext", WFTextActionText=text(ext_input()))
    add("setvariable", WFVariableName="Link", WFInput=attach(out(a_link, "Text")))

    # Mode: YouTube asks video or audio
    a_auto = add("gettext", WFTextActionText="auto")
    add("setvariable", WFVariableName="Mode", WFInput=attach(out(a_auto, "Text")))
    # No text compare in If (breaks on newer iOS): match text, then test "has any value".
    a_yt = add("text.match", WFMatchTextPattern="youtu", WFMatchTextCaseSensitive=False,
               text=text(var("Link")))
    g_yt = uid()
    add("conditional", GroupingIdentifier=g_yt, WFControlFlowMode=0, WFCondition=100,
        WFInput=cond_input(out(a_yt, "Matches")))
    g_menu = uid()
    add("choosefrommenu", GroupingIdentifier=g_menu, WFControlFlowMode=0,
        WFMenuPrompt="Save as?", WFMenuItems=["Video", "Audio (MP3)"])
    add("choosefrommenu", GroupingIdentifier=g_menu, WFControlFlowMode=1, WFMenuItemTitle="Video")
    add("choosefrommenu", GroupingIdentifier=g_menu, WFControlFlowMode=1, WFMenuItemTitle="Audio (MP3)")
    a_audio = add("gettext", WFTextActionText="audio")
    add("setvariable", WFVariableName="Mode", WFInput=attach(out(a_audio, "Text")))
    add("choosefrommenu", GroupingIdentifier=g_menu, WFControlFlowMode=2)
    add("conditional", GroupingIdentifier=g_yt, WFControlFlowMode=2)

    # Ask the server
    a_res = add("downloadurl",
                WFURL=text(var("Server"), "/resolve"),
                WFHTTPMethod="POST",
                ShowHeaders=True,
                WFHTTPHeaders=dict_field([("X-Token", [var("Token")])]),
                WFHTTPBodyType="JSON",
                WFJSONValues=dict_field([("url", [var("Link")]), ("mode", [var("Mode")])]))
    add("setvariable", WFVariableName="Response", WFInput=attach(out(a_res, "Contents of URL")))

    # Error from server -> show it and stop
    a_err = add("getvalueforkey", WFInput=attach(var("Response")), WFDictionaryKey="error",
                WFGetDictionaryValueType="Value")
    g_err = uid()
    add("conditional", GroupingIdentifier=g_err, WFControlFlowMode=0, WFCondition=100,
        WFInput=cond_input(out(a_err, "Dictionary Value")))
    add("alert", WFAlertActionTitle="Failed",
        WFAlertActionMessage=text(out(a_err, "Dictionary Value")),
        WFAlertActionCancelButtonShown=False)
    add("exit")
    add("conditional", GroupingIdentifier=g_err, WFControlFlowMode=2)

    # Download and save each file
    a_files = add("getvalueforkey", WFInput=attach(var("Response")), WFDictionaryKey="files",
                  WFGetDictionaryValueType="Value")
    g_rep = uid()
    add("repeat.each", GroupingIdentifier=g_rep, WFControlFlowMode=0,
        WFInput=attach(out(a_files, "Dictionary Value")))
    a_url = add("getvalueforkey", WFInput=attach(var("Repeat Item")), WFDictionaryKey="url",
                WFGetDictionaryValueType="Value")
    a_name = add("getvalueforkey", WFInput=attach(var("Repeat Item")), WFDictionaryKey="name",
                 WFGetDictionaryValueType="Value")
    a_kind = add("getvalueforkey", WFInput=attach(var("Repeat Item")), WFDictionaryKey="saveToFiles",
                 WFGetDictionaryValueType="Value")
    a_dl = add("downloadurl", WFURL=text(out(a_url, "Dictionary Value")), WFHTTPMethod="GET")
    # Name the file with its extension so iOS knows it is a video/image/audio
    a_named = add("setitemname", WFInput=attach(out(a_dl, "Contents of URL")),
                  WFName=text(out(a_name, "Dictionary Value")), WFDontIncludeFileExtension=False)
    g_kind = uid()
    add("conditional", GroupingIdentifier=g_kind, WFControlFlowMode=0, WFCondition=100,
        WFInput=cond_input(out(a_kind, "Dictionary Value")))
    add("documentpicker.save", WFInput=attach(out(a_named, "Renamed Item")), WFAskWhereToSave=True)
    add("conditional", GroupingIdentifier=g_kind, WFControlFlowMode=1)
    add("savetocameraroll", WFInput=attach(out(a_named, "Renamed Item")), WFCameraRollSelectedGroup="Recents")
    add("conditional", GroupingIdentifier=g_kind, WFControlFlowMode=2)
    add("repeat.each", GroupingIdentifier=g_rep, WFControlFlowMode=2)

    # Notification wording comes from the server, so it can change without reinstalling.
    a_ntitle = add("getvalueforkey", WFInput=attach(var("Response")), WFDictionaryKey="notifyTitle",
                   WFGetDictionaryValueType="Value")
    a_nbody = add("getvalueforkey", WFInput=attach(var("Response")), WFDictionaryKey="notifyBody",
                  WFGetDictionaryValueType="Value")
    add("notification", WFNotificationActionTitle=text(out(a_ntitle, "Dictionary Value")),
        WFNotificationActionBody=text(out(a_nbody, "Dictionary Value")),
        WFNotificationActionSound=False)

    return acts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("output")
    ap.add_argument("--server", default="")
    ap.add_argument("--token", default="")
    a = ap.parse_args()

    acts = build(a.server.rstrip("/"), a.token)
    questions = []
    if not a.server:
        questions.append({"ActionIndex": 0, "Category": "Parameter", "ParameterKey": "WFTextActionText",
                          "DefaultValue": "https://", "Text": "Server address (e.g. https://dl.example.com)"})
    if not a.token:
        questions.append({"ActionIndex": 2, "Category": "Parameter", "ParameterKey": "WFTextActionText",
                          "DefaultValue": "", "Text": "Your token"})

    wf = {
        "WFWorkflowClientVersion": "2605.0.5",
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowIcon": {"WFWorkflowIconStartColor": 2071128575, "WFWorkflowIconGlyphNumber": 59821},  # violet, repostArrows
        "WFWorkflowTypes": ["ActionExtension"],
        "WFWorkflowInputContentItemClasses": ["WFURLContentItem", "WFStringContentItem"],
        "WFWorkflowHasShortcutInputVariables": True,
        "WFWorkflowNoInputBehavior": {"Name": "WFWorkflowNoInputBehaviorGetClipboard", "Parameters": {}},
        "WFWorkflowImportQuestions": questions,
        "WFWorkflowActions": acts,
        "WFQuickActionSurfaces": [],
        "WFWorkflowOutputContentItemClasses": [],
    }
    with open(a.output, "wb") as f:
        plistlib.dump(wf, f, fmt=plistlib.FMT_BINARY)
    print(f"wrote {a.output} ({len(acts)} actions, {len(questions)} import question(s))")


if __name__ == "__main__":
    main()

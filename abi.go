package main

/*
#include <stdint.h>
#include <stdlib.h>

typedef struct {void* ptr; size_t len;} cliproxy_buffer;
typedef int (*cliproxy_host_call_fn)(void*, const char*, const uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_host_free_fn)(void*, size_t);
typedef struct {uint32_t abi_version; void* host_ctx; cliproxy_host_call_fn call; cliproxy_host_free_fn free_buffer;} cliproxy_host_api;
typedef int (*cliproxy_plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_plugin_free_fn)(void*, size_t);
typedef void (*cliproxy_plugin_shutdown_fn)(void);
typedef struct {uint32_t abi_version; cliproxy_plugin_call_fn call; cliproxy_plugin_free_fn free_buffer; cliproxy_plugin_shutdown_fn shutdown;} cliproxy_plugin_api;
extern int cliproxyPluginCall(char*, uint8_t*, size_t, cliproxy_buffer*);
extern void cliproxyPluginFree(void*, size_t);
extern void cliproxyPluginShutdown(void);
*/
import "C"

import (
	"encoding/json"
	"unsafe"
)

type envelope struct {
	OK     bool           `json:"ok"`
	Result any            `json:"result,omitempty"`
	Error  *envelopeError `json:"error,omitempty"`
}
type envelopeError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func main() {}

//export cliproxy_plugin_init
func cliproxy_plugin_init(host *C.cliproxy_host_api, plugin *C.cliproxy_plugin_api) C.int {
	if plugin == nil || host == nil || host.abi_version != 1 {
		return 1
	}
	plugin.abi_version = 1
	plugin.call = C.cliproxy_plugin_call_fn(C.cliproxyPluginCall)
	plugin.free_buffer = C.cliproxy_plugin_free_fn(C.cliproxyPluginFree)
	plugin.shutdown = C.cliproxy_plugin_shutdown_fn(C.cliproxyPluginShutdown)
	return 0
}

//export cliproxyPluginCall
func cliproxyPluginCall(method *C.char, request *C.uint8_t, requestLen C.size_t, response *C.cliproxy_buffer) (status C.int) {
	if response == nil {
		return 1
	}
	response.ptr = nil
	response.len = 0
	defer func() {
		if recover() != nil {
			writeEnvelope(response, envelope{Error: &envelopeError{Code: "plugin_error", Message: "statistics plugin operation failed"}})
			status = 1
		}
	}()
	if method == nil || requestLen > 128<<20 || (request == nil && requestLen > 0) {
		writeEnvelope(response, envelope{Error: &envelopeError{Code: "invalid_request", Message: "invalid plugin request"}})
		return 1
	}
	var raw []byte
	if requestLen > 0 {
		raw = C.GoBytes(unsafe.Pointer(request), C.int(requestLen))
	}
	result, err := runtimeInstance.handleMethod(C.GoString(method), raw)
	if err != nil {
		writeEnvelope(response, envelope{Error: &envelopeError{Code: "plugin_error", Message: err.Error()}})
		return 0
	}
	writeEnvelope(response, envelope{OK: true, Result: result})
	return 0
}

//export cliproxyPluginFree
func cliproxyPluginFree(ptr unsafe.Pointer, length C.size_t) {
	if ptr != nil {
		C.free(ptr)
	}
}

//export cliproxyPluginShutdown
func cliproxyPluginShutdown() { _ = runtimeInstance.shutdown() }
func writeEnvelope(response *C.cliproxy_buffer, value envelope) {
	raw, err := json.Marshal(value)
	if err != nil {
		raw = []byte(`{"ok":false,"error":{"code":"encoding_error","message":"response encoding failed"}}`)
	}
	if len(raw) > 0 {
		response.ptr = C.CBytes(raw)
		response.len = C.size_t(len(raw))
	}
}
